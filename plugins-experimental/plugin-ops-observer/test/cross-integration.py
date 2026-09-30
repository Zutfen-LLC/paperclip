"""Opt-in bounded real-candidate qualification; no deploy/restart/config writes.
After npm run build, run: python3 test/cross-integration.py <ops-checkout> <receipt>
Credentials stay in memory/stdin. The secret resolver is a scoped test harness.
"""
import base64, hashlib, http.cookiejar, importlib.util, json, os, pathlib
import shlex, sqlite3, subprocess, sys, threading, urllib.request
from urllib.parse import urlsplit
PIN = "82acd5431e527687b3da0349bb8cc27de04d519f"
PKG = pathlib.Path(__file__).resolve().parents[1]
COMPANY = "5c5295b6-0e26-4079-b06c-138f35086278"
PLUGIN = "a6061d98-ffe9-4cb3-b1d7-33f817d46fb3"
def run(argv):
    return subprocess.check_output(argv, text=True, timeout=120).strip()
def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()
def fingerprint():
    db = pathlib.Path.home()/".local/share/ops-supervisor-v2/tasks.db"
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as c:
        c.execute("BEGIN")
        tables = {}
        for t in ("tasks", "events", "runs"):
            rows = c.execute(f"SELECT * FROM {t} ORDER BY rowid").fetchall()
            tables[t] = {"count": len(rows), "sha256": digest(rows)}
        return {"tables": tables, "db_sha256": hashlib.sha256("\n".join(c.iterdump()).encode()).hexdigest()}
def board(path):
    jar = http.cookiejar.MozillaCookieJar(str(pathlib.Path.home()/".ssh/keys-poc/pc-board-cookies"))
    jar.load(ignore_discard=True, ignore_expires=True)
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    req = urllib.request.Request("http://10.0.0.34:3100"+path, headers={"Origin":"http://10.0.0.34:3100"}, method="GET")
    with opener.open(req, timeout=30) as r:
        assert r.status == 200
        return json.load(r)
def issues():
    return sorted(({k:r.get(k) for k in ("id","title","createdAt")} for r in board(f"/api/companies/{COMPANY}/issues")), key=lambda r:r["id"])
def remote(command):
    return ["ssh","-o","BatchMode=yes","pm04","sudo -n pct exec 152 -- "+command]
def services():
    args = ["-p","MainPID","-p","NRestarts","-p","ExecMainStartTimestampMonotonic"]
    local = {name:run(["systemctl","--user","show",name]+args) for name in ("ops-supervisor-api.service","ops-supervisor-scheduler.service","ops-readonly-adapter.service")}
    local["tunnel"] = run(remote(shlex.join(["systemctl","show","ops-observer-tunnel.service"]+args)))
    return local
def qualify(token, tunnel=False):
    job = {"companyId":COMPANY,"token":token}
    if tunnel:
        job["workerUrl"] = "data:text/javascript;base64,"+base64.b64encode((PKG/"dist/worker.js").read_bytes()).decode()
        harness = "data:text/javascript;base64,"+base64.b64encode((PKG/"test/cross-integration-worker.mjs").read_bytes()).decode()
        argv = remote("runuser -u paperclip -- "+shlex.join(["node","--input-type=module","-e",f"await import({json.dumps(harness)})"]))
    else:
        argv = ["node",str(PKG/"test/cross-integration-worker.mjs")]
    r = subprocess.run(argv, input=json.dumps(job), capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, f"worker qualification failed, tunnel={tunnel}; diagnostics withheld"
    assert token not in r.stdout and token not in r.stderr, "credential exposed"
    return json.loads(r.stdout)
def main():
    repo, out = map(pathlib.Path, sys.argv[1:])
    assert run(["git","-C",str(repo),"rev-parse","HEAD"]) == PIN
    source = repo/"scripts/ops_readonly_adapter.py"
    blob = subprocess.check_output(["git","-C",str(repo),"show",f"{PIN}:scripts/ops_readonly_adapter.py"])
    assert source.read_bytes() == blob, "candidate differs from pinned Git blob"
    token = (pathlib.Path.home()/".config/ops-supervisor/ops-readonly-adapter.token").read_text().strip()
    assert token
    config = board(f"/api/plugins/{PLUGIN}/config?companyId={COMPANY}")["configJson"]
    assert config["adapterBaseUrl"] in ("http://127.0.0.1:18487","http://127.0.0.1:18487/")
    assert config["adapterToken"] == token, "deployed integration credential mismatch"
    config_before = digest(config)
    del config
    before, issues_before, services_before = fingerprint(), issues(), services()
    unit = run(remote("systemctl cat ops-observer-tunnel.service"))
    assert "-L 127.0.0.1:18487:127.0.0.1:8487" in unit
    spec = importlib.util.spec_from_file_location("qualified_adapter", source)
    adapter = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = adapter
    spec.loader.exec_module(adapter)
    calls, real_open = [], adapter.urlopen
    def spy(req,*args,**kwargs):
        assert req.get_method() == "GET", "upstream write attempted"
        assert not req.has_header("Authorization"), "credential forwarded upstream"
        parsed = urlsplit(req.full_url)
        assert f"{parsed.scheme}://{parsed.netloc}" == "http://127.0.0.1:8484"
        calls.append({"method":req.get_method(),"path":parsed.path})
        return real_open(req,*args,**kwargs)
    adapter.urlopen = spy
    pid = run(["systemctl","--user","show","ops-supervisor-api.service","-p","MainPID","--value"])
    ops_sha = run(["git","-C",os.readlink(f"/proc/{pid}/cwd"),"rev-parse","HEAD"])
    class Handler(adapter.ReadonlySnapshotHandler):
        adapter_token = token
        ops_base_url = "http://127.0.0.1:8484"
        ops_deployed_sha = ops_sha
        def log_message(self,*args): pass
    # Fail if occupied; never stop a service or widen the pinned destination.
    server = adapter.ThreadingHTTPServer(("127.0.0.1",18487), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        candidate = qualify(token)
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=10)
        adapter.urlopen = real_open
    assert not thread.is_alive()
    assert calls and {r["method"] for r in calls} == {"GET"}
    # Exact built worker runs in memory on CT152, no files or installs there.
    deployed_tunnel = qualify(token, tunnel=True)
    after, issues_after, services_after = fingerprint(), issues(), services()
    assert before == after, "Ops state changed during qualification"
    assert issues_before == issues_after, "Paperclip issues changed"
    assert services_before == services_after, "production service restart detected"
    assert config_before == digest(board(f"/api/plugins/{PLUGIN}/config?companyId={COMPANY}")["configJson"]), "production plugin configuration changed"
    assert not any("ops" in str(r.get("title","")).lower() for r in issues_after)
    result = {"paperclip_head":run(["git","-C",str(PKG),"rev-parse","HEAD"]),
              "worker_sha256":hashlib.sha256((PKG/"dist/worker.js").read_bytes()).hexdigest(),
              "ops_candidate":PIN,"ops_candidate_source_sha256":hashlib.sha256(blob).hexdigest(),
              "ops_upstream_sha":ops_sha,"approved_origin":"http://127.0.0.1:18487",
              "tunnel":"127.0.0.1:18487 -> 127.0.0.1:8487",
              "candidate_worker":candidate,"existing_tunnel_worker":deployed_tunnel,
              "upstream_requests":len(calls),"upstream_methods":["GET"],"upstream_credential_forwarded":False,
              "before":before,"after":after,"fingerprints_unchanged":True,
              "paperclip_issue_count":len(issues_after),"paperclip_issue_sha256":digest(issues_after),
              "paperclip_issues_unchanged":True,"mirror_issues":0,"production_services_unchanged":True,
              "qualification_listener_closed":True,
              "limitations":["Company-scoped resolver is a harness, not live secret migration.",
                              "Existing tunnel serves the unchanged running adapter; exact candidate runs in the separate temporary pinned-origin listener."]}
    assert token not in json.dumps(result), "credential exposure in receipt"
    out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(result,indent=2)+"\n")
    print(json.dumps(result,indent=2))
if __name__ == "__main__": main()
