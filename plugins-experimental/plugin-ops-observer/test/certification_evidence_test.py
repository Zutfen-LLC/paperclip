"""Isolated slice-B tests: no production services or live cross-integration."""
import hashlib
import json
import logging
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'certification'))
from adapter_evidence import AdapterEvidence, load_pinned_adapter, PinnedAdapterError
from window_scanner import CATEGORIES, EvidenceError, scan_inventory
from window_collector import collect_inventory

ADAPTER = Path('/home/zutfen/ops-v2/observer-issue-3/scripts/ops_readonly_adapter.py')
SECRET = 'private-token-sentinel-issue10'
LEAK = 'private-header-sentinel-issue10'


class Server:
    def __init__(self, handler):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:%d' % self.server.server_port

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        assert not self.thread.is_alive()


class Fixture(BaseHTTPRequestHandler):
    hits = []
    redirect = None
    def do_GET(self):
        self.hits.append((self.command, self.path, dict(self.headers)))
        if self.redirect:
            self.send_response(302)
            self.send_header('Location', self.redirect)
            self.end_headers()
            return
        payload = {'/api/tasks': [], '/api/projects': [], '/api/token-usage': {'tasks': []}, '/api/readiness': {}}[self.path]
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_): pass


class AdapterTests(unittest.TestCase):
    def setUp(self):
        Fixture.hits = []
        Fixture.redirect = None
        self.upstream = Server(Fixture)
        self.module = load_pinned_adapter(ADAPTER)
        handler = type('IsolatedPinnedHandler', (self.module.ReadonlySnapshotHandler,),
                       {'adapter_token': SECRET, 'ops_base_url': self.upstream.url,
                        'ops_deployed_sha': 'isolated-fixture'})
        self.adapter = Server(handler)

    def tearDown(self):
        self.adapter.close()
        self.upstream.close()

    def request(self, token):
        req = Request(self.adapter.url + '/snapshot', headers={'Authorization': 'Bearer ' + token,
                                                               'Cookie': LEAK})
        try:
            with urlopen(req, timeout=3) as response:
                return response.status
        except HTTPError as exc:
            return exc.code

    def test_pinned_blob_and_sha_drift_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            altered = Path(tmp) / 'adapter.py'
            altered.write_bytes(ADAPTER.read_bytes() + b'\n# drift\n')
            with self.assertRaises(PinnedAdapterError):
                load_pinned_adapter(altered)

    def test_real_handler_auth_then_real_request_opener_method_headers_and_lifecycle(self):
        with AdapterEvidence(self.module) as evidence:
            self.assertEqual(self.request('wrong'), 401)
            self.assertEqual(Fixture.hits, [])
            self.assertEqual(self.request(SECRET), 200)
            deadline = time.monotonic() + 2
            while evidence.report['inFlight'] and time.monotonic() < deadline:
                time.sleep(0.001)
            report = evidence.close()
        self.assertEqual(report['status'], 'complete')
        self.assertEqual(report['authRejected'], 1)
        self.assertEqual(report['authAccepted'], 1)
        self.assertEqual(report['opsAttempts'], 4)
        self.assertEqual(report['opsSuccesses'], 4)
        self.assertEqual(report['opsFailures'], 0)
        self.assertEqual(report['upstreamMethod'], 'GET')
        self.assertTrue(report['headersOnlyOwned'])
        self.assertFalse(report['upstreamAuthorizationAttached'])
        self.assertFalse(report['upstreamCookieAttached'])
        self.assertFalse(report['upstreamProxyAuthorizationAttached'])
        self.assertEqual([entry[0] for entry in Fixture.hits], ['GET'] * 4)
        self.assertNotIn(SECRET, json.dumps(report))
        self.assertNotIn(LEAK, json.dumps(report))

    def test_non_get_is_sticky_in_both_mixed_orders(self):
        for methods in (('POST', 'GET'), ('GET', 'POST')):
            with self.subTest(methods=methods):
                with AdapterEvidence(self.module) as evidence:
                    for method in methods:
                        try:
                            self.module.urlopen(Request(self.upstream.url + '/api/tasks', method=method), timeout=2)
                        except HTTPError:
                            pass
                    report = evidence.close()
                self.assertEqual(report['opsAttempts'], 2)
                self.assertEqual(report['upstreamMethod'], 'other')
                self.assertEqual(report['status'], 'incomplete')
                self.assertEqual(report['incompleteReason'], 'non_get_upstream')
                self.assertEqual(report, evidence.close())

    def test_explicit_sensitive_header_ownership_is_sticky(self):
        with AdapterEvidence(self.module) as evidence:
            for headers in ({'Authorization': SECRET, 'Cookie': LEAK}, {}):
                with self.module.urlopen(Request(self.upstream.url + '/api/tasks', headers=headers), timeout=2):
                    pass
            report = evidence.close()
        self.assertEqual(report['upstreamMethod'], 'GET')
        self.assertFalse(report['headersOnlyOwned'])
        self.assertTrue(report['upstreamAuthorizationAttached'])
        self.assertTrue(report['upstreamCookieAttached'])
        self.assertNotIn(SECRET, json.dumps(report))
        self.assertNotIn(LEAK, json.dumps(report))

    def test_redirect_real_opener_refuses_target_without_echo(self):
        target_hits = []
        class Target(BaseHTTPRequestHandler):
            def do_GET(self): target_hits.append(1); self.send_response(200); self.end_headers()
            def log_message(self, *_): pass
        target = Server(Target)
        captured = []
        class Capture(logging.Handler):
            def emit(self, record): captured.append(self.format(record))
        sink = Capture()
        self.module.LOG.addHandler(sink)
        try:
            Fixture.redirect = target.url + '/leak?token=' + SECRET
            with AdapterEvidence(self.module) as evidence:
                self.assertEqual(self.request(SECRET), 502)
                report = evidence.close()
            self.assertEqual(target_hits, [])
            self.assertEqual(report['redirectRefusals'], 1)
            self.assertEqual(report['opsAttempts'], 1)
            self.assertEqual(report['opsFailures'], 1)
            self.assertNotIn(SECRET, json.dumps(report))
            self.assertNotIn(SECRET, json.dumps(captured))
            self.assertNotIn(LEAK, json.dumps(captured))
            self.assertNotIn('/leak?token=', json.dumps(captured))
        finally:
            self.module.LOG.removeHandler(sink)
            target.close()

    def test_hook_refuses_unpinned_or_concurrent_module_context(self):
        with self.assertRaises(PinnedAdapterError): AdapterEvidence(object())
        with AdapterEvidence(self.module):
            with self.assertRaises(RuntimeError):
                with AdapterEvidence(self.module): pass

    def test_expired_window_refuses_complete(self):
        with AdapterEvidence(self.module, max_seconds=300) as evidence:
            evidence.started -= 301
            receipt = evidence.close()
        self.assertEqual(receipt['status'], 'incomplete')
        self.assertEqual(receipt['incompleteReason'], 'window_expired')

    def test_overlap_and_event_cap_cannot_be_complete(self):
        with AdapterEvidence(self.module, max_events=1) as evidence:
            self.assertEqual(self.request(SECRET), 200)
            self.assertEqual(evidence.close()['status'], 'incomplete')
            self.assertEqual(evidence.close()['incompleteReason'], 'event_limit')
        with AdapterEvidence(self.module) as evidence:
            evidence._entered_request()
            receipt = evidence.close()
            evidence._left_request()
            self.assertEqual(receipt, evidence.close())
            self.assertEqual(receipt['status'], 'incomplete')
            self.assertEqual(receipt['incompleteReason'], 'request_overlap')


class ScannerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.inventory = {'schema': 'ops_observer_window_inventory_v1', 'window': 'isolated-1',
                          'startedAt': 100, 'endedAt': 200, 'sources': {}}
        for category in CATEGORIES:
            self.put(category, {'ordinary': 'safe'})

    def cache_receipt(self):
        return {'schema': 'ops_observer_certification_v1', 'status': 'complete',
                'incompleteReason': None, 'startedAt': 100, 'endedAt': 200, 'inFlight': 0,
                'upstreamMethod': 'none', 'adapterAuthHeaderAttached': False,
                'counters': {'acceptedOrigin': 0, 'rejectedOrigin': 0,
                    'secretResolutionAttempts': 0, 'secretResolutionFailures': 0,
                    'cacheReads': 0, 'cacheHits': 0, 'cacheMisses': 0,
                    'cacheRefreshes': 0, 'fetchAttempts': 0, 'fetchSuccesses': 0,
                    'fetchFailures': 0, 'redirectRefusals': 0, 'upstreamGet': 0,
                    'adapterAuthAttached': 0},
                'cacheIdentifiers': {'schema': 'ops_worker_cache_identifiers_v1',
                    'scans': 2, 'entriesInspected': 0, 'reads': 0, 'inserts': 0,
                    'leaks': 0, 'shapeViolations': 0, 'digest': '0' * 64}}

    def put(self, category, payload):
        if category == 'cache_identifiers' and 'receipt' not in payload:
            payload = {'receipt': self.cache_receipt(), 'metadata': payload}
        records = [{'seq': 0, 'at': 100, 'kind': 'start', 'payload': {}},
                   {'seq': 1, 'at': 150, 'kind': 'data', 'payload': payload},
                   {'seq': 2, 'at': 200, 'kind': 'end', 'payload': {}}]
        raw = json.dumps({'window': 'isolated-1', 'records': records}).encode()
        path = self.root / (category + '.json')
        path.write_bytes(raw)
        self.inventory['sources'][category] = {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
           'bytes': len(raw), 'coverage': {'startedAt': 100, 'endedAt': 200, 'complete': True,
                                          'truncated': False, 'overflow': False, 'collector': 'isolated-fixture'}}

    def scan(self): return scan_inventory(self.inventory, [SECRET, LEAK])

    def test_all_categories_clean_with_complete_markers(self):
        result = self.scan()
        self.assertEqual(result['status'], 'clean')
        self.assertEqual(set(result['categories']), set(CATEGORIES))
        self.assertTrue(all(v['matches'] == 0 for v in result['categories'].values()))

    def test_positive_control_nested_leak_each_category_never_echoes(self):
        for category in CATEGORIES:
            self.put(category, {'nested': [{'header': {'value': LEAK}}, {'token': SECRET}]})
            result = self.scan()
            self.assertEqual(result['status'], 'leak')
            self.assertEqual(result['categories'][category]['matches'], 2)
            self.assertNotIn(SECRET, json.dumps(result)); self.assertNotIn(LEAK, json.dumps(result))
            self.put(category, {'ordinary': 'safe'})

    def test_missing_truncation_overflow_digest_sequence_and_empty_fabrication_refused(self):
        source = self.inventory['sources']['worker_logs']
        for mutation in [lambda: self.inventory['sources'].pop('worker_logs'),
                         lambda: source['coverage'].update(truncated=True),
                         lambda: source['coverage'].update(overflow=True),
                         lambda: source.update(bytes=0),
                         lambda: source.update(sha256='0' * 64)]:
            import copy
            saved = copy.deepcopy(self.inventory)
            mutation()
            with self.assertRaises(EvidenceError) as ctx: self.scan()
            self.assertNotIn(str(self.root), str(ctx.exception))
            self.inventory = saved
            source = self.inventory['sources']['worker_logs']
        self.put('worker_logs', {'ordinary': 'safe'})
        source = self.inventory['sources']['worker_logs']
        p = Path(source['path'])
        for records in [[], [{'seq': 0, 'at': 100, 'kind': 'start', 'payload': {}}],
                        [{'seq': 0, 'at': 100, 'kind': 'start', 'payload': {}},
                         {'seq': 1, 'at': 200, 'kind': 'end', 'payload': {}}],
                        [{'seq': 0, 'at': 100, 'kind': 'start', 'payload': {}},
                         {'seq': 2, 'at': 200, 'kind': 'end', 'payload': {}}]]:
            raw = json.dumps({'window': 'isolated-1', 'records': records}).encode()
            p.write_bytes(raw); source['bytes'] = len(raw); source['sha256'] = hashlib.sha256(raw).hexdigest()
            with self.assertRaises(EvidenceError): self.scan()

    def test_cli_private_stdin_never_echoes_leak_or_path(self):
        self.put('errors', {'nested': {'value': SECRET}})
        inventory = self.root / 'inventory.json'
        inventory.write_text(json.dumps(self.inventory))
        result = subprocess.run([sys.executable, '-B', str(ROOT / 'certification' / 'window_scanner.py'),
                                 str(inventory)], input=json.dumps({'values': [SECRET, LEAK]}),
                                text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)['status'], 'leak')
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        self.assertNotIn(str(self.root), result.stdout + result.stderr)

    def test_cache_receipt_must_be_trusted_shape_complete_and_consistent(self):
        for mutation in (lambda r: r.update(status='incomplete'),
                         lambda r: r.update(endedAt=201),
                         lambda r: r['cacheIdentifiers'].update(leaks=1),
                         lambda r: r['cacheIdentifiers'].update(shapeViolations=1),
                         lambda r: r['cacheIdentifiers'].update(scans=1),
                         lambda r: r['cacheIdentifiers'].update(reads=1),
                         lambda r: r['cacheIdentifiers'].update(digest='bad'),
                         lambda r: r.update(rawKeys=['private-company']),
                         lambda r: r['cacheIdentifiers'].update(rawKeys=['private-company'])):
            receipt = self.cache_receipt()
            mutation(receipt)
            self.put('cache_identifiers', {'receipt': receipt})
            with self.assertRaises(EvidenceError): self.scan()
        self.put('cache_identifiers', {'receipt': self.cache_receipt()})
        self.assertEqual(self.scan()['status'], 'clean')

    def test_complete_cache_receipt_cannot_claim_insertion_without_inspecting_it(self):
        receipt = self.cache_receipt()
        receipt['counters'].update(acceptedOrigin=1, cacheReads=1, cacheMisses=1,
                                   fetchAttempts=1, fetchSuccesses=1, upstreamGet=1,
                                   adapterAuthAttached=1)
        receipt['cacheIdentifiers'].update(scans=4, reads=1, inserts=1)
        # A successful insert is synchronously followed by a scan of the new key.
        self.put('cache_identifiers', {'receipt': receipt})
        with self.assertRaisesRegex(EvidenceError, 'cache_receipt_mismatch'):
            self.scan()

    def test_complete_cache_receipt_cannot_have_inspections_with_zero_digest(self):
        receipt = self.cache_receipt()
        receipt['cacheIdentifiers'].update(entriesInspected=1)
        self.put('cache_identifiers', {'receipt': receipt})
        with self.assertRaisesRegex(EvidenceError, 'cache_receipt_integrity'):
            self.scan()

    def test_complete_cache_receipt_allows_empty_rejection_and_hit_refresh_windows(self):
        self.assertEqual(self.scan()['status'], 'clean')  # zero-fetch, empty cache
        rejected = self.cache_receipt()
        rejected['counters']['rejectedOrigin'] = 1
        self.put('cache_identifiers', {'receipt': rejected})
        self.assertEqual(self.scan()['status'], 'clean')
        traffic = self.cache_receipt()
        traffic['counters'].update(acceptedOrigin=3, cacheReads=3, cacheHits=1,
                                   cacheMisses=1, cacheRefreshes=1, fetchAttempts=2,
                                   fetchSuccesses=2, upstreamGet=2, adapterAuthAttached=2)
        traffic['cacheIdentifiers'].update(scans=7, reads=3, inserts=2,
                                           entriesInspected=5, digest='a' * 64)
        self.put('cache_identifiers', {'receipt': traffic})
        self.assertEqual(self.scan()['status'], 'clean')

    def test_cache_receipt_plaintext_positive_control(self):
        receipt = self.cache_receipt()
        self.put('cache_identifiers', {'receipt': receipt, 'unexpected': SECRET})
        self.assertEqual(self.scan()['status'], 'leak')
        self.assertNotIn(SECRET, json.dumps(self.scan()))

    def test_collector_ingests_actual_export_files_and_rejects_unattested_or_overflow(self):
        export = {'schema': 'ops_observer_export_v1', 'window': 'isolated-1',
                  'startedAt': 100, 'endedAt': 200, 'sources': {}}
        for category in CATEGORIES:
            path = self.root / ('raw-' + category)
            raw = json.dumps(self.cache_receipt() if category == 'cache_identifiers'
                             else {'events': [], 'note': 'actually exported'}).encode()
            path.write_bytes(raw)
            export['sources'][category] = {'path': str(path), 'bytes': len(raw),
              'sha256': hashlib.sha256(raw).hexdigest(), 'coverage': {
                'startedAt': 100, 'endedAt': 200, 'complete': True, 'truncated': False,
                'overflow': False, 'collector': 'operator-export', 'startCursor': 'before', 'endCursor': 'after'}}
        result = collect_inventory(export, self.root / 'collected')
        self.assertEqual(scan_inventory(result, [SECRET])['status'], 'clean')
        fake = (self.root / 'raw-cache_identifiers')
        forged = b'{"status":"clean"}'
        fake.write_bytes(forged)
        export['sources']['cache_identifiers']['bytes'] = len(forged)
        export['sources']['cache_identifiers']['sha256'] = hashlib.sha256(forged).hexdigest()
        with self.assertRaises(EvidenceError): collect_inventory(export, self.root / 'fake-cache')
        proper = json.dumps(self.cache_receipt()).encode()
        fake.write_bytes(proper)
        export['sources']['cache_identifiers']['bytes'] = len(proper)
        export['sources']['cache_identifiers']['sha256'] = hashlib.sha256(proper).hexdigest()
        export['sources']['worker_logs']['coverage']['startCursor'] = ''
        with self.assertRaises(EvidenceError): collect_inventory(export, self.root / 'bad')
        export['sources']['worker_logs']['coverage']['startCursor'] = 'before'
        (self.root / 'raw-worker_logs').write_bytes(b'Z' * export['sources']['worker_logs']['bytes'])
        with self.assertRaises(EvidenceError): collect_inventory(export, self.root / 'changed')
        (self.root / 'raw-worker_logs').write_bytes(b'X' * (4 * 1024 * 1024 + 1))
        with self.assertRaises(EvidenceError): collect_inventory(export, self.root / 'overflow')

    def test_marker_race_and_finite_limit_refused(self):
        source = self.inventory['sources']['telemetry']
        source['coverage']['endedAt'] = 201
        with self.assertRaises(EvidenceError): self.scan()
        source['coverage']['endedAt'] = 200
        with self.assertRaises(EvidenceError): scan_inventory(self.inventory, [SECRET], max_source_bytes=10)
        with self.assertRaises(EvidenceError): scan_inventory(self.inventory, [SECRET], max_records=2)


if __name__ == '__main__': unittest.main()
