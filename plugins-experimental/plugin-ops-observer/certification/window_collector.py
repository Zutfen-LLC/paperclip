"""Wrap independently exported complete sink files into bounded scanner inventory.

The collector does NOT export process logs or attest that external sources are
complete; a sanctioned operator must capture each full runtime sink and supply
truthful start/end cursor attestations before invoking it.
"""
import hashlib
import json
import os
from pathlib import Path
from window_scanner import CATEGORIES, EvidenceError, MAX_SOURCE_BYTES


def collect_inventory(export, destination):
    if (not isinstance(export, dict) or export.get('schema') != 'ops_observer_export_v1'
        or not isinstance(export.get('sources'), dict) or set(export['sources']) != set(CATEGORIES)):
        raise EvidenceError('invalid_export_inventory')
    start, end, window = export.get('startedAt'), export.get('endedAt'), export.get('window')
    if (type(start) not in (int, float) or type(end) not in (int, float) or start >= end
        or not isinstance(window, str) or not window):
        raise EvidenceError('invalid_window')
    captures = {}
    # Validate *all* exports before writing anything; no best-effort partial success.
    for category in CATEGORIES:
        source = export['sources'][category]
        if not isinstance(source, dict) or not isinstance(source.get('coverage'), dict):
            raise EvidenceError('invalid_export_source')
        coverage = source['coverage']
        if (coverage.get('startedAt') != start or coverage.get('endedAt') != end
            or coverage.get('complete') is not True or coverage.get('truncated') is not False
            or coverage.get('overflow') is not False
            or any(not isinstance(coverage.get(key), str) or not coverage[key]
                   for key in ('collector', 'startCursor', 'endCursor'))):
            raise EvidenceError('unattested_export')
        path = source.get('path')
        if not isinstance(path, str) or not path: raise EvidenceError('invalid_export_source')
        try:
            with open(path, 'rb') as f: raw = f.read(MAX_SOURCE_BYTES + 1)
            if not raw or len(raw) > MAX_SOURCE_BYTES: raise EvidenceError('export_limit_or_empty')
            if (source.get('bytes') != len(raw) or
                source.get('sha256') != hashlib.sha256(raw).hexdigest()):
                raise EvidenceError('export_integrity_failure')
            captures[category] = raw.decode('utf-8')
        except (OSError, UnicodeError):
            raise EvidenceError('export_unavailable_or_encoding') from None
    destination = Path(destination)
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    inventory = {'schema': 'ops_observer_window_inventory_v1', 'window': window,
                 'startedAt': start, 'endedAt': end, 'sources': {}}
    for category, text in captures.items():
        data = {'window': window, 'records': [
            {'seq': 0, 'at': start, 'kind': 'start', 'payload': {}},
            {'seq': 1, 'at': start, 'kind': 'data', 'payload': {'export': text}},
            {'seq': 2, 'at': end, 'kind': 'end', 'payload': {}}]}
        raw = json.dumps(data, ensure_ascii=False).encode('utf-8')
        if len(raw) > MAX_SOURCE_BYTES: raise EvidenceError('wrapped_export_limit')
        path = destination / (category + '.json')
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as f: f.write(raw)
        # The scanner needs fixed coverage booleans, not cursor strings; the
        # original operator export manifest retains the independent attestation.
        coverage = export['sources'][category]['coverage']
        inventory['sources'][category] = {
            'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
            'coverage': {key: coverage[key] for key in ('startedAt', 'endedAt', 'complete',
                                                       'truncated', 'overflow', 'collector')}}
    return inventory


def main():
    import sys
    try:
        if len(sys.argv) != 3: raise EvidenceError('usage')
        path = Path(sys.argv[1])
        if path.stat().st_size > 1024 * 1024: raise EvidenceError('export_manifest_limit')
        export = json.loads(path.read_text(encoding='utf-8'))
        destination = Path(sys.argv[2])
        inventory = collect_inventory(export, destination)
        output = destination / 'inventory.json'
        fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f: json.dump(inventory, f)
        # No stdout paths/source identifiers that could contain secret material.
        print(json.dumps({'status': 'collected', 'categories': len(CATEGORIES)}))
        return 0
    except (EvidenceError, OSError, ValueError, TypeError, UnicodeError):
        print(json.dumps({'status': 'incomplete', 'reason': 'invalid_or_incomplete_export'}))
        return 2


if __name__ == '__main__':
    import sys
    sys.exit(main())
