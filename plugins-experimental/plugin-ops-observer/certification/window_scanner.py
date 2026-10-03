"""Bounded complete-window inventory scanner. Secrets enter only through stdin in CLI mode.

This verifies supplied exports, not the collector's independent claim that its
export included every production sink. Never print content, paths or values.
"""
import hashlib
import json
import sys
from pathlib import Path
from typing import NoReturn

CATEGORIES = ('worker_logs', 'plugin_logs', 'adapter_logs', 'errors', 'telemetry',
              'cache_identifiers', 'emitted_envelopes', 'persisted_receipts')
MAX_SOURCE_BYTES = 4 * 1024 * 1024
MAX_RECORDS = 10_000
CACHE_RECEIPT_FIELDS = frozenset(('schema', 'status', 'incompleteReason',
    'startedAt', 'endedAt', 'inFlight', 'counters', 'cacheIdentifiers',
    'upstreamMethod', 'adapterAuthHeaderAttached'))
CACHE_EVIDENCE_FIELDS = frozenset(('schema', 'scans', 'entriesInspected',
    'reads', 'inserts', 'leaks', 'shapeViolations', 'digest'))
WORKER_COUNTER_FIELDS = frozenset(('acceptedOrigin', 'rejectedOrigin',
    'secretResolutionAttempts', 'secretResolutionFailures', 'cacheReads',
    'cacheHits', 'cacheMisses', 'cacheRefreshes', 'fetchAttempts',
    'fetchSuccesses', 'fetchFailures', 'redirectRefusals', 'upstreamGet',
    'adapterAuthAttached'))


class EvidenceError(ValueError):
    pass


def validate_cache_receipt(receipt, start, end):
    """Validate a worker-generated, authorized bridge receipt, not a made-up clean file.

    Provenance of the captured bridge response remains an operator attestation;
    metadata alone cannot authenticate an installed process against forgery.
    """
    if not isinstance(receipt, dict) or receipt.get('schema') != 'ops_observer_certification_v1':
        _reject('cache_receipt_required')
    evidence = receipt.get('cacheIdentifiers')
    counters = receipt.get('counters')
    if (receipt.get('status') != 'complete' or receipt.get('incompleteReason') is not None
        or receipt.get('startedAt') != start or receipt.get('endedAt') != end
        or type(receipt.get('inFlight')) is not int or receipt['inFlight'] != 0
        or not isinstance(evidence, dict) or evidence.get('schema') != 'ops_worker_cache_identifiers_v1'
        or not isinstance(counters, dict)):
        _reject('cache_receipt_incomplete')
    if (set(receipt) != CACHE_RECEIPT_FIELDS or set(evidence) != CACHE_EVIDENCE_FIELDS
        or set(counters) != WORKER_COUNTER_FIELDS
        or any(type(value) is not int or not 0 <= value <= MAX_RECORDS
               for value in counters.values())):
        _reject('cache_receipt_shape')
    fields = ('scans', 'entriesInspected', 'reads', 'inserts', 'leaks', 'shapeViolations')
    if any(type(evidence.get(k)) is not int or not 0 <= evidence[k] <= MAX_RECORDS for k in fields):
        _reject('cache_inventory_limit')
    if (evidence['leaks'] or evidence['shapeViolations']
        or evidence['scans'] < 2 + evidence['reads'] + evidence['inserts']
        or evidence['reads'] != counters.get('cacheReads')
        or evidence['inserts'] != counters.get('fetchSuccesses')
        or type(counters.get('cacheReads')) is not int
        or type(counters.get('fetchSuccesses')) is not int):
        _reject('cache_receipt_mismatch')
    digest = evidence.get('digest')
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        _reject('cache_receipt_integrity')


def _reject(reason) -> NoReturn:
    raise EvidenceError(reason)


def scan_inventory(inventory, values, *, max_source_bytes=MAX_SOURCE_BYTES, max_records=MAX_RECORDS):
    """Require every category's digest, size, coverage and ordered start/end markers."""
    if not isinstance(inventory, dict) or inventory.get('schema') != 'ops_observer_window_inventory_v1':
        _reject('invalid_inventory')
    sources = inventory.get('sources')
    if not isinstance(sources, dict) or set(sources) != set(CATEGORIES):
        _reject('missing_or_extra_source')
    start, end = inventory.get('startedAt'), inventory.get('endedAt')
    window = inventory.get('window')
    if not isinstance(window, str) or not window or not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in (start, end)) or start >= end:
        _reject('invalid_window')
    if (not isinstance(values, list) or not values or len(values) > 32
        or any(not isinstance(v, str) or not v or len(v.encode('utf-8')) > 4096 for v in values)):
        _reject('invalid_private_values')
    if not 1 <= max_source_bytes <= MAX_SOURCE_BYTES or not 2 <= max_records <= MAX_RECORDS:
        _reject('invalid_limit')
    patterns = [v.encode('utf-8') for v in set(values)]
    categories = {}
    for category in CATEGORIES:
        source = sources[category]
        if not isinstance(source, dict): _reject('invalid_source')
        coverage = source.get('coverage')
        if (not isinstance(coverage, dict) or coverage.get('startedAt') != start
            or coverage.get('endedAt') != end or coverage.get('complete') is not True
            or coverage.get('truncated') is not False or coverage.get('overflow') is not False
            or not isinstance(coverage.get('collector'), str) or not coverage['collector']):
            _reject('incomplete_coverage')
        size, digest, path = source.get('bytes'), source.get('sha256'), source.get('path')
        if (type(size) is not int or not 1 <= size <= max_source_bytes or
            not isinstance(digest, str) or len(digest) != 64 or
            not isinstance(path, str) or not path): _reject('invalid_source_metadata')
        try:
            with open(path, 'rb') as handle: raw = handle.read(max_source_bytes + 1)
        except OSError: _reject('source_unavailable')
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
            _reject('source_integrity_failure')
        try:
            data = json.loads(raw.decode('utf-8'))
        except (UnicodeError, ValueError): _reject('invalid_source_encoding')
        if not isinstance(data, dict) or data.get('window') != window or not isinstance(data.get('records'), list):
            _reject('invalid_records')
        records = data['records']
        if category == 'cache_identifiers':
            if len(records) != 3 or not isinstance(records[1], dict):
                _reject('cache_receipt_required')
            payload = records[1].get('payload')
            if not isinstance(payload, dict): _reject('cache_receipt_required')
            if 'export' in payload:
                try: worker_receipt = json.loads(payload['export'])
                except (TypeError, ValueError): _reject('cache_receipt_required')
            else:
                worker_receipt = payload.get('receipt')
            validate_cache_receipt(worker_receipt, start, end)
        if not 3 <= len(records) <= max_records: _reject('record_limit_or_empty')
        if any(not isinstance(record, dict) for record in records): _reject('invalid_record')
        if (records[0].get('kind') != 'start' or records[-1].get('kind') != 'end'
            or records[0].get('at') != start or records[-1].get('at') != end):
            _reject('marker_mismatch')
        last_at = start
        matches = 0
        for index, record in enumerate(records):
            if not isinstance(record, dict): _reject('invalid_record')
            at = record.get('at')
            if (record.get('seq') != index or type(at) not in (int, float)
                or not start <= at <= end or at < last_at
                or record.get('kind') not in ('start', 'data', 'end')
                or (index not in (0, len(records)-1) and record['kind'] != 'data')
                or 'payload' not in record): _reject('record_gap_or_race')
            last_at = at
            # Search actual UTF-8 source bytes (including JSON escaping/keys) AND
            # decoded payloads, so escaped Unicode secrets cannot evade detection.
            if record['kind'] == 'data':
                serialized = json.dumps(record['payload'], ensure_ascii=False).encode('utf-8')
                matches += sum(serialized.count(value) for value in patterns)
        # Whole raw source also includes metadata and JSON-escaped representation.
        # Count raw matches not already represented by decoded nested payload scan.
        raw_matches = sum(raw.count(value) for value in patterns)
        matches = max(matches, raw_matches)
        categories[category] = {'matches': matches, 'records': len(records), 'bytes': size, 'sha256': digest}
    return {'schema': 'ops_observer_hygiene_v1', 'status': 'leak' if any(v['matches'] for v in categories.values()) else 'clean',
            'categories': categories}


def main():
    # argv contains only inventory path; values arrive through private stdin.
    try:
        if len(sys.argv) != 2: _reject('usage')
        inventory_path = Path(sys.argv[1])
        if inventory_path.stat().st_size > 1024 * 1024: _reject('inventory_limit')
        inventory = json.loads(inventory_path.read_text(encoding='utf-8'))
        private = sys.stdin.buffer.read(128 * 1024 + 1)
        if len(private) > 128 * 1024: _reject('private_input_limit')
        values = json.loads(private.decode('utf-8'))['values']
        result = scan_inventory(inventory, values)
    except (EvidenceError, OSError, KeyError, TypeError, ValueError, UnicodeError) as exc:
        # Fixed, bounded reason only; even JSON errors and paths can contain secrets.
        reason = str(exc) if isinstance(exc, EvidenceError) else 'invalid_input'
        print(json.dumps({'schema': 'ops_observer_hygiene_v1', 'status': 'incomplete', 'reason': reason}))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 1 if result['status'] == 'leak' else 0


if __name__ == '__main__': sys.exit(main())
