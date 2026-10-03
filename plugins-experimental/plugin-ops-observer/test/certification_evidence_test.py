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
        manifest = {'schema': 'ops_observer_export_v1', 'window': 'isolated-1',
                    'startedAt': 100, 'endedAt': 200, 'sources': {}}
        for key, source in self.inventory['sources'].items():
            manifest['sources'][key] = {**{k: source[k] for k in ('path', 'bytes', 'sha256')},
                'coverage': {**source['coverage'], 'startCursor': 'before', 'endCursor': 'after'}}
        manifest_path = self.root / 'direct-manifest.json'
        manifest_raw = json.dumps(manifest).encode()
        manifest_path.write_bytes(manifest_raw)
        self.inventory['exportManifest'] = {'path': str(manifest_path), 'bytes': len(manifest_raw),
                                            'sha256': hashlib.sha256(manifest_raw).hexdigest()}

    def scan(self): return scan_inventory(self.inventory, [SECRET, LEAK])

    def export_manifest(self):
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
        return export

    def replace_export(self, export, category, raw):
        source = export['sources'][category]
        Path(source['path']).write_bytes(raw)
        source['bytes'] = len(raw)
        source['sha256'] = hashlib.sha256(raw).hexdigest()

    def collect(self, export, destination):
        manifest_path = self.root / (destination.name + '-original.json')
        manifest_path.write_text(json.dumps(export))
        return collect_inventory(export, destination, manifest_path)

    def assert_private_inventory_leak(self, inventory, value=SECRET):
        result = scan_inventory(inventory, [value])
        self.assertEqual(result['status'], 'leak')
        self.assertGreater(sum(item['matches'] for item in result['categories'].values()), 0)
        self.assertNotIn(value, json.dumps(result))
        path = self.root / 'private-inventory.json'
        path.write_text(json.dumps(inventory))
        cli = subprocess.run([sys.executable, '-B', str(ROOT / 'certification' / 'window_scanner.py'),
                              str(path)], input=json.dumps({'values': [value]}),
                             text=True, capture_output=True, timeout=5)
        self.assertEqual(cli.returncode, 1, cli.stdout + cli.stderr)
        self.assertEqual(json.loads(cli.stdout)['status'], 'leak')
        self.assertNotIn(value, cli.stdout + cli.stderr)
        self.assertNotIn(str(self.root), cli.stdout + cli.stderr)

    def test_retained_inventory_extra_field_and_metadata_key_are_leaks(self):
        for mutation in (lambda inventory: inventory.update(unexpected={'nested': SECRET}),
                         lambda inventory: inventory['sources']['worker_logs']['coverage'].update({SECRET: 'safe'})):
            with self.subTest(mutation=mutation):
                inventory = self.collect(self.export_manifest(), self.root / ('metadata-' + str(len(list(self.root.iterdir())))))
                mutation(inventory)
                self.assert_private_inventory_leak(inventory)

    def test_retained_original_manifest_filename_is_a_leak(self):
        export = self.export_manifest()
        path = self.root / ('manifest-' + SECRET + '.json')
        path.write_text(json.dumps(export))
        inventory = collect_inventory(export, self.root / 'manifest-path', path)
        self.assert_private_inventory_leak(inventory)
        path.write_text(json.dumps(export) + ' ')
        with self.assertRaises(EvidenceError): scan_inventory(inventory, [SECRET])
        path.unlink()
        with self.assertRaises(EvidenceError): scan_inventory(inventory, [SECRET])

    def test_retained_source_filenames_are_leaks(self):
        export = self.export_manifest()
        source = export['sources']['worker_logs']
        original = Path(source['path'])
        renamed = self.root / ('source-' + SECRET + '.json')
        original.rename(renamed)
        source['path'] = str(renamed)
        inventory = self.collect(export, self.root / 'source-path')
        self.assert_private_inventory_leak(inventory)
        clean_export = self.export_manifest()
        wrapped = self.collect(clean_export, self.root / ('wrapped-' + SECRET))
        self.assert_private_inventory_leak(wrapped)

    def test_retained_inventory_escaped_json_string_is_a_leak(self):
        inventory = self.collect(self.export_manifest(), self.root / 'inventory-escaped')
        inventory['extra'] = SECRET
        path = self.root / 'escaped-inventory.json'
        escaped = ''.join('\\u%04x' % ord(char) for char in SECRET)
        path.write_text(json.dumps(inventory).replace(SECRET, escaped))
        cli = subprocess.run([sys.executable, '-B', str(ROOT / 'certification' / 'window_scanner.py'),
                              str(path)], input=json.dumps({'values': [SECRET]}),
                             text=True, capture_output=True, timeout=5)
        self.assertEqual(cli.returncode, 1, cli.stdout + cli.stderr)
        self.assertEqual(json.loads(cli.stdout)['status'], 'leak')
        self.assertNotIn(SECRET, cli.stdout + cli.stderr)

    def test_retained_inventory_raw_duplicate_key_and_literal_escape_are_leaks(self):
        inventory = self.collect(self.export_manifest(), self.root / 'inventory-raw')
        path = self.root / 'raw-inventory.json'
        base = json.dumps(inventory)
        for encoding, field in enumerate(('"obsolete":"' + SECRET + '",',
                      '"obsolete":"' + ''.join('\\u%04x' % ord(char) for char in SECRET) + '",',
                      '"obsolete":"' + ''.join('\\\\u%04x' % ord(char) for char in SECRET) + '",')):
            with self.subTest(encoding=encoding):
                # The first duplicate is erased by json.loads; raw bytes must still be inspected.
                path.write_text('{' + field + '"obsolete":"safe",' + base[1:])
                cli = subprocess.run([sys.executable, '-B', str(ROOT / 'certification' / 'window_scanner.py'),
                                      str(path)], input=json.dumps({'values': [SECRET]}),
                                     text=True, capture_output=True, timeout=5)
                self.assertEqual(cli.returncode, 1, cli.stdout + cli.stderr)
                self.assertEqual(json.loads(cli.stdout)['status'], 'leak')
                self.assertNotIn(SECRET, cli.stdout + cli.stderr)

    def test_retained_original_manifest_all_fields_raw_and_decoded_no_echo(self):
        escaped = ''.join('\\u%04x' % ord(char) for char in SECRET)
        for field in ('startCursor', 'endCursor', 'unexpectedMetadata', 'sourceMetadata', 'topLevelMetadata'):
            for encoding in ('plain', 'escaped'):
                with self.subTest(field=field, encoding=encoding):
                    export = self.export_manifest()
                    if field == 'topLevelMetadata':
                        export[field] = SECRET
                    elif field == 'sourceMetadata':
                        export['sources']['worker_logs'][field] = SECRET
                    else:
                        export['sources']['worker_logs']['coverage'][field] = SECRET
                    manifest = self.root / ('manifest-' + field + '-' + encoding + '.json')
                    raw = json.dumps(export).replace(SECRET, escaped if encoding == 'escaped' else SECRET)
                    manifest.write_text(raw)
                    destination = self.root / ('retained-' + field + '-' + encoding)
                    cli = subprocess.run([sys.executable, '-B', str(ROOT / 'certification' / 'window_collector.py'),
                                          str(manifest), str(destination)], text=True, capture_output=True, timeout=5)
                    self.assertEqual(cli.returncode, 0, cli.stdout + cli.stderr)
                    inventory = json.loads((destination / 'inventory.json').read_text())
                    result = scan_inventory(inventory, [SECRET])
                    self.assertEqual(result['status'], 'leak')
                    self.assertGreater(result['categories']['worker_logs']['matches'], 0)
                    scanner = subprocess.run([sys.executable, '-B', str(ROOT / 'certification' / 'window_scanner.py'),
                                              str(destination / 'inventory.json')], input=json.dumps({'values': [SECRET]}),
                                             text=True, capture_output=True, timeout=5)
                    self.assertEqual(scanner.returncode, 1)
                    self.assertNotIn(SECRET, cli.stdout + cli.stderr + scanner.stdout + scanner.stderr + json.dumps(result))

    def test_retained_original_manifest_missing_or_modified_is_incomplete(self):
        export = self.export_manifest()
        manifest = self.root / 'retained-source.json'
        manifest.write_text(json.dumps(export))
        destination = self.root / 'retained-source'
        cli = subprocess.run([sys.executable, '-B', str(ROOT / 'certification' / 'window_collector.py'),
                              str(manifest), str(destination)], text=True, capture_output=True, timeout=5)
        self.assertEqual(cli.returncode, 0)
        inventory = json.loads((destination / 'inventory.json').read_text())
        self.assertEqual(scan_inventory(inventory, [SECRET])['status'], 'clean')
        manifest.write_text(json.dumps(export) + ' ')
        with self.assertRaises(EvidenceError): scan_inventory(inventory, [SECRET])
        scanner = subprocess.run([sys.executable, '-B', str(ROOT / 'certification' / 'window_scanner.py'),
                                  str(destination / 'inventory.json')], input=json.dumps({'values': [SECRET]}),
                                 text=True, capture_output=True, timeout=5)
        self.assertEqual(scanner.returncode, 2)
        self.assertNotIn(str(manifest), scanner.stdout + scanner.stderr)
        self.assertNotIn(SECRET, scanner.stdout + scanner.stderr)
        manifest.write_text(json.dumps(export))
        original_source = Path(export['sources']['worker_logs']['path'])
        original_source.write_bytes(original_source.read_bytes() + b' ')
        with self.assertRaises(EvidenceError): scan_inventory(inventory, [SECRET])
        manifest.unlink()
        with self.assertRaises(EvidenceError): scan_inventory(inventory, [SECRET])
        inventory.pop('exportManifest', None)
        with self.assertRaises(EvidenceError): scan_inventory(inventory, [SECRET])

    def test_collector_unicode_escaped_json_and_log_lines_each_sink(self):
        escaped = ''.join('\\u%04x' % ord(char) for char in SECRET)
        for category in CATEGORIES:
            with self.subTest(category=category):
                export = self.export_manifest()
                if category == 'cache_identifiers':
                    receipt = self.cache_receipt()
                    receipt['upstreamMethod'] = SECRET
                    raw = json.dumps(receipt).replace(SECRET, escaped).encode()
                else:
                    raw = ('{"event":"' + escaped + '"}').encode()
                    if category == 'worker_logs':
                        raw = b'{"event":"ordinary"}\n' + raw + b'\n'
                self.replace_export(export, category, raw)
                inventory = self.collect(export, self.root / ('escaped-' + category))
                result = scan_inventory(inventory, [SECRET])
                self.assertEqual(result['status'], 'leak')
                self.assertGreater(result['categories'][category]['matches'], 0)
                self.assertNotIn(SECRET, json.dumps(result))

    def test_collector_json_string_export_and_metadata_are_scanned(self):
        export = self.export_manifest()
        self.replace_export(export, 'errors', json.dumps(SECRET).encode())
        export['sources']['worker_logs']['coverage']['collector'] = SECRET
        inventory = self.collect(export, self.root / 'metadata')
        result = scan_inventory(inventory, [SECRET])
        self.assertEqual(result['status'], 'leak')
        self.assertNotIn(SECRET, json.dumps(result))
        inventory['sources']['worker_logs']['coverage']['collector'] = 'operator-export'
        with self.assertRaises(EvidenceError): scan_inventory(inventory, [SECRET])
        self.replace_export(export, 'errors', b'{"safe":true}')
        export['sources']['worker_logs']['coverage']['collector'] = 'operator-export'
        export['window'] = ''.join('\\u%04x' % ord(c) for c in SECRET)
        clean = self.collect(export, self.root / 'window-meta')
        self.assertEqual(scan_inventory(clean, [SECRET])['status'], 'leak')

    def test_allowed_worker_receipt_metadata_private_value_is_not_clean(self):
        receipt = self.cache_receipt()
        receipt['upstreamMethod'] = SECRET
        self.put('cache_identifiers', {'receipt': receipt})
        result = self.scan()
        self.assertEqual(result['status'], 'leak')
        self.assertNotIn(SECRET, json.dumps(result))

    def test_collector_private_coverage_metadata_and_unexpected_receipt_fields(self):
        export = self.export_manifest()
        export['sources']['worker_logs']['coverage']['collector'] = SECRET
        inventory = self.collect(export, self.root / 'collector-private')
        result = scan_inventory(inventory, [SECRET])
        self.assertEqual(result['status'], 'leak')
        self.assertGreater(result['categories']['worker_logs']['matches'], 0)
        self.assertNotIn(SECRET, json.dumps(result))
        inventory['extra'] = SECRET
        self.assert_private_inventory_leak(inventory)

    def test_collector_malformed_or_deep_json_is_incomplete_without_echo(self):
        for index, raw in enumerate((b'{"event":"\\u0070"', b'[' * 64 + b'0' + b']' * 64)):
            export = self.export_manifest()
            self.replace_export(export, 'worker_logs', raw)
            inventory = self.collect(export, self.root / ('malformed-' + str(index)))
            with self.assertRaises(EvidenceError) as ctx:
                scan_inventory(inventory, [SECRET])
            self.assertNotIn(raw.decode(), str(ctx.exception))
            path = self.root / ('inventory-' + str(index) + '.json')
            path.write_text(json.dumps(inventory))
            cli = subprocess.run([sys.executable, '-B', str(ROOT / 'certification' / 'window_scanner.py'),
                                  str(path)], input=json.dumps({'values': [SECRET]}),
                                 text=True, capture_output=True, timeout=5)
            self.assertEqual(cli.returncode, 2)
            self.assertEqual(json.loads(cli.stdout)['status'], 'incomplete')
            self.assertNotIn(raw.decode(), cli.stdout + cli.stderr)

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
        result = self.collect(export, self.root / 'collected')
        self.assertEqual(scan_inventory(result, [SECRET])['status'], 'clean')
        fake = (self.root / 'raw-cache_identifiers')
        forged = b'{"status":"clean"}'
        fake.write_bytes(forged)
        export['sources']['cache_identifiers']['bytes'] = len(forged)
        export['sources']['cache_identifiers']['sha256'] = hashlib.sha256(forged).hexdigest()
        with self.assertRaises(EvidenceError): self.collect(export, self.root / 'fake-cache')
        proper = json.dumps(self.cache_receipt()).encode()
        fake.write_bytes(proper)
        export['sources']['cache_identifiers']['bytes'] = len(proper)
        export['sources']['cache_identifiers']['sha256'] = hashlib.sha256(proper).hexdigest()
        export['sources']['worker_logs']['coverage']['startCursor'] = ''
        with self.assertRaises(EvidenceError): self.collect(export, self.root / 'bad')
        export['sources']['worker_logs']['coverage']['startCursor'] = 'before'
        (self.root / 'raw-worker_logs').write_bytes(b'Z' * export['sources']['worker_logs']['bytes'])
        with self.assertRaises(EvidenceError): self.collect(export, self.root / 'changed')
        (self.root / 'raw-worker_logs').write_bytes(b'X' * (4 * 1024 * 1024 + 1))
        with self.assertRaises(EvidenceError): self.collect(export, self.root / 'overflow')

    def test_marker_race_and_finite_limit_refused(self):
        source = self.inventory['sources']['telemetry']
        source['coverage']['endedAt'] = 201
        with self.assertRaises(EvidenceError): self.scan()
        source['coverage']['endedAt'] = 200
        with self.assertRaises(EvidenceError): scan_inventory(self.inventory, [SECRET], max_source_bytes=10)
        with self.assertRaises(EvidenceError): scan_inventory(self.inventory, [SECRET], max_records=2)


if __name__ == '__main__': unittest.main()
