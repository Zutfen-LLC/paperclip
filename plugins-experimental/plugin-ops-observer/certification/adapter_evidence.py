"""Opt-in evidence hook on the pinned *real* Ops adapter, never a replacement adapter.

Install only around a sanctioned adapter listener. No network calls are made here.
The adapter's original do_GET, compare_digest and no-redirect opener still decide
all behavior. Keep the context open through listener shutdown/drain before close.
"""
import hashlib
import importlib.util
import threading
import time
from pathlib import Path
from urllib.error import HTTPError

PINNED_GIT_BLOB = 'f085f4f3fe473379808e8be2f1fce61eafee565f'
PINNED_SHA256 = '1cebf8d9675e0955ceefc9400de06a9160b1d1029832f6f6c310a47878531d1f'


class PinnedAdapterError(ValueError):
    pass


def load_pinned_adapter(path):
    """Refuse unreviewed bytes *before* executing the actual adapter module."""
    try:
        raw = Path(path).read_bytes()
    except OSError:
        raise PinnedAdapterError('pinned_adapter_unavailable') from None
    blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
    if blob != PINNED_GIT_BLOB or hashlib.sha256(raw).hexdigest() != PINNED_SHA256:
        raise PinnedAdapterError('pinned_adapter_drift')
    spec = importlib.util.spec_from_file_location('pinned_ops_readonly_adapter', path)
    if not spec or not spec.loader:
        raise PinnedAdapterError('pinned_adapter_unavailable')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.__pinned_adapter_blob__ = blob
    return module


class AdapterEvidence:
    """Aggregate actual authentication and upstream opener boundaries; one context/module.

    This is opt-in in-process instrumentation. Never activate across two
    simultaneous evidence contexts or close before handler threads drain.
    """
    def __init__(self, module, max_events=10_000, max_seconds=300):
        if getattr(module, '__pinned_adapter_blob__', None) != PINNED_GIT_BLOB:
            raise PinnedAdapterError('pinned_adapter_required')
        if not 1 <= max_events <= 10_000 or not 1 <= max_seconds <= 300:
            raise ValueError('invalid_evidence_limit')
        self.module = module
        self.limit = max_events
        self.max_seconds = max_seconds
        self.started = time.monotonic()
        self.lock = threading.RLock()
        self.report = dict(schema='ops_adapter_evidence_v1', status='active', incompleteReason=None,
                           authAccepted=0, authRejected=0, opsAttempts=0, opsSuccesses=0,
                           opsFailures=0, redirectRefusals=0, upstreamMethod='none',
                           headersOnlyOwned=True, upstreamAuthorizationAttached=False,
                           upstreamCookieAttached=False, upstreamProxyAuthorizationAttached=False,
                           inFlight=0)
        self.events = 0
        self.non_get_seen = False
        self.closed = None
        self.installed = False

    def _expire(self):
        if self.report['status'] == 'active' and time.monotonic() - self.started >= self.max_seconds:
            self.report['status'] = 'incomplete'
            self.report['incompleteReason'] = 'window_expired'

    def _event(self):
        with self.lock:
            self._expire()
            if self.closed is not None or self.report['status'] != 'active':
                return False
            if self.events >= self.limit:
                self.report['status'] = 'incomplete'
                self.report['incompleteReason'] = 'event_limit'
                return False
            self.events += 1
            return True

    def _entered_request(self):
        with self.lock:
            self.report['inFlight'] += 1

    def _left_request(self):
        with self.lock:
            self.report['inFlight'] -= 1

    def __enter__(self):
        if self.installed or getattr(self.module, '__active_evidence__', None) is not None:
            raise RuntimeError('evidence_already_installed')
        self.started = time.monotonic()
        m = self.module
        m.__active_evidence__ = self
        self.original_open = m.urlopen
        self.original_secrets = m.secrets
        self.original_get = m.ReadonlySnapshotHandler.do_GET
        def observed_compare(a, b):
            result = self.original_secrets.compare_digest(a, b)
            if self._event():
                with self.lock:
                    self.report['authAccepted' if result else 'authRejected'] += 1
            return result
        class SecretsProxy:
            compare_digest = staticmethod(observed_compare)
            def __getattr__(self, name): return getattr(self_outer.original_secrets, name)
        self_outer = self
        def observed_open(request, *args, **kwargs):
            method = request.get_method()
            header_names = {name.lower() for name, _ in request.header_items()}
            if self._event():
                with self.lock:
                    self.report['opsAttempts'] += 1
                    if method != 'GET':
                        self.non_get_seen = True
                        self.report['upstreamMethod'] = 'other'
                    elif self.report['upstreamMethod'] == 'none':
                        self.report['upstreamMethod'] = 'GET'
                    self.report['headersOnlyOwned'] &= not bool(header_names)
                    for key, name in [('upstreamAuthorizationAttached', 'authorization'),
                                      ('upstreamCookieAttached', 'cookie'),
                                      ('upstreamProxyAuthorizationAttached', 'proxy-authorization')]:
                        self.report[key] |= name in header_names
            try:
                result = self.original_open(request, *args, **kwargs)
            except Exception as exc:
                if self._event():
                    with self.lock:
                        self.report['opsFailures'] += 1
                        if isinstance(exc, HTTPError) and 300 <= exc.code < 400:
                            self.report['redirectRefusals'] += 1
                raise
            if self._event():
                with self.lock: self.report['opsSuccesses'] += 1
            return result
        def observed_get(handler):
            self._entered_request()
            try: return self.original_get(handler)
            finally: self._left_request()
        m.secrets = SecretsProxy()
        m.urlopen = observed_open
        m.ReadonlySnapshotHandler.do_GET = observed_get
        self.installed = True
        return self

    def close(self):
        with self.lock:
            if self.closed is None:
                self._expire()
                if self.report['status'] == 'active':
                    if self.report['inFlight']:
                        self.report['status'] = 'incomplete'
                        self.report['incompleteReason'] = 'request_overlap'
                    else:
                        self.report['status'] = 'complete'
                if self.non_get_seen and self.report['status'] == 'complete':
                    self.report['status'] = 'incomplete'
                    self.report['incompleteReason'] = 'non_get_upstream'
                self.closed = dict(self.report)
            return dict(self.closed)

    def __exit__(self, *_):
        self.close()
        if self.installed:
            self.module.ReadonlySnapshotHandler.do_GET = self.original_get
            self.module.urlopen = self.original_open
            self.module.secrets = self.original_secrets
            self.module.__active_evidence__ = None
            self.installed = False
