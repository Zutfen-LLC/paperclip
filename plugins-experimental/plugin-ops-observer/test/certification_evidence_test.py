"""Isolated slice-B tests: no production services or live cross-integration."""
import hashlib
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'certification'))
from adapter_evidence import AdapterEvidence, load_pinned_adapter, PinnedAdapterError
from window_scanner import CATEGORIES, EvidenceError, scan_inventory

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

    def test_redirect_real_opener_refuses_target_without_echo(self):
        target_hits = []
        class Target(BaseHTTPRequestHandler):
            def do_GET(self): target_hits.append(1); self.send_response(200); self.end_headers()
            def log_message(self, *_): pass
        target = Server(Target)
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
        finally: target.close()

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

    def put(self, category, payload):
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
        p = Path(source['path'])
        for records in [[], [{'seq': 0, 'at': 100, 'kind': 'start', 'payload': {}}],
                        [{'seq': 0, 'at': 100, 'kind': 'start', 'payload': {}},
                         {'seq': 2, 'at': 200, 'kind': 'end', 'payload': {}}]]:
            raw = json.dumps({'window': 'isolated-1', 'records': records}).encode()
            p.write_bytes(raw); source['bytes'] = len(raw); source['sha256'] = hashlib.sha256(raw).hexdigest()
            with self.assertRaises(EvidenceError): self.scan()

    def test_marker_race_and_finite_limit_refused(self):
        source = self.inventory['sources']['telemetry']
        source['coverage']['endedAt'] = 201
        with self.assertRaises(EvidenceError): self.scan()
        source['coverage']['endedAt'] = 200
        with self.assertRaises(EvidenceError): scan_inventory(self.inventory, [SECRET], max_source_bytes=10)
        with self.assertRaises(EvidenceError): scan_inventory(self.inventory, [SECRET], max_records=2)


if __name__ == '__main__': unittest.main()
