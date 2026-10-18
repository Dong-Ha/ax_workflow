"""Frozen G1 toolchain/migration gate. This does not perform G2-G7 acceptance."""
from datetime import datetime, timezone
from hashlib import sha256
from importlib import metadata
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_PLAN = "f53a6d86e3e798d77a23741a923f95f960936179f26c4a2648df9b6178daf96a"


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def sources():
    paths = [ROOT / ".gitignore", ROOT / "README.md", Path(__file__).resolve(), ROOT / "docs/ifpmic/B02-IDENTITY.md"]
    for directory in ["services/ifpmic_api", "tests/ifpmic_api"]:
        paths += [p for p in (ROOT / directory).rglob("*") if p.is_file() and p.suffix in {".py", ".sql", ".in", ".lock"}]
    paths += list((ROOT / "docs/ifpmic/evidence/b02").glob("*.json"))
    return {str(p.relative_to(ROOT)): digest(p) for p in sorted(set(paths))}


def check_environment():
    if Path(sys.prefix).resolve() != (ROOT / ".ifpmic-venv").resolve() or sys.version_info[:2] != (3, 12):
        raise RuntimeError("G1 requires the isolated Python3.12 environment")
    lock = (ROOT / "services/ifpmic_api/requirements.lock").read_text()
    expected = {name.lower().replace("_", "-"): version for name, version in re.findall(r"^([\w.-]+)==([^\s\\]+)", lock, re.M)}
    actual = {d.metadata["Name"].lower().replace("_", "-"): d.version for d in metadata.distributions()}
    if not expected or expected != actual:
        raise RuntimeError("Installed distributions differ from the hash lock")
    if any(name.startswith(("opentelemetry-sdk", "opentelemetry-exporter")) for name in actual):
        raise RuntimeError("Unexpected telemetry SDK/exporter")
    import fastapi
    from fastapi.testclient import TestClient
    from authlib.integrations.starlette_client import OAuth
    app = fastapi.FastAPI()
    @app.get("/health")
    def health():
        return {"ok": True}
    with TestClient(app) as client:
        if client.get("/health").json() != {"ok": True}:
            raise RuntimeError("FastAPI/TestClient compatibility failed")
    OAuth().register("synthetic-probe", client_id="synthetic-only", client_kwargs={"scope": "openid", "code_challenge_method": "S256"})
    return {"python": platform.python_version(), "implementation": platform.python_implementation(), "platform": sys.platform,
            "distributions": dict(sorted(actual.items())), "hash_lock_sha256": digest(ROOT / "services/ifpmic_api/requirements.lock"),
            "fastapi_testclient": "pass", "authlib_client_construction": "pass", "oidc_protocol": "not_executed"}


def check_unchanged_sources():
    with zipfile.ZipFile(ROOT / "docs/ifpmic/evidence/b01/local-profile-gate.zip") as archive:
        raw = archive.read("gate/gate.json")
    if sha256(raw).hexdigest() != "597c3ada698cd20ff9c93a318e1177fe55e43e68844d08a6c56281cf940cb2c6":
        raise RuntimeError("Accepted B01 baseline changed")
    baseline = json.loads(raw)
    prefixes = ("src/", "server/", "plugins/", "runtime/ifpmic/")
    protected = {p: value for p, value in baseline["sourceHashes"].items() if p.startswith(prefixes) or (p.startswith("tests/") and p.endswith(".mjs")) or p in {
        "package.json", "package-lock.json", "scripts/build-ifpmic-plugin.mjs", "vite.config.ts", "tsconfig.json", "index.html", "ifpmic.html"}}
    for path, value in protected.items():
        if digest(ROOT / path) != value:
            raise RuntimeError("Protected existing AX/UI/Node source changed")
    current = {str(p.relative_to(ROOT)) for directory in ("src", "server", "plugins", "runtime/ifpmic") for p in (ROOT / directory).rglob("*") if p.is_file()}
    current.update(str(p.relative_to(ROOT)) for p in (ROOT / "tests").rglob("*.mjs"))
    if current != {p for p in protected if p.startswith(prefixes) or p.startswith("tests/")}:
        raise RuntimeError("Protected existing source inventory changed")
    original = json.loads((ROOT / "docs/ifpmic/source-manifest.json").read_text())
    for path, value in original["imported_files"].items():
        if digest(ROOT / "docs/ifpmic/design-v1" / path) != value:
            raise RuntimeError("Original design source changed")
    for item in original["source_files"].values():
        if digest(ROOT / item["path"]) != item["sha256"]:
            raise RuntimeError("Original uploaded source changed")
    return {"protected_source_count": len(protected), "protected_inventory_count": len(current),
            "original_imported_files": len(original["imported_files"]), "original_uploads": len(original["source_files"]),
            "scope": "Byte/inventory comparison only. Full Node/build/browser G6 remains pending."}


def cleanup_cluster(manifest):
    """Observe and stop only the exact private fixture cluster, never restart it."""
    if not manifest.exists():
        return "manifest_unavailable"
    data = json.loads(manifest.read_text())
    pg_ctl = ROOT / ".paperclip-lab/runtime/node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl"
    if Path(data["pg_ctl_path"]).resolve() != pg_ctl.resolve() or digest(pg_ctl) != data["binary_sha256"]["pg_ctl"]:
        return "cleanup_identity_rejected"
    directory = Path(data["data_dir"])
    pid_file = directory / "postmaster.pid"
    if not pid_file.exists():
        return "already_stopped"
    if int(pid_file.read_text().splitlines()[0]) != data["server_pid"]:
        return "cleanup_identity_rejected"
    env = {"PATH": f"{pg_ctl.parent}:/usr/bin:/bin", "LANG": "C.UTF-8"}
    status = subprocess.run([str(pg_ctl), "-D", str(directory), "status"], capture_output=True, timeout=5, env=env)
    if status.returncode != 0:
        return "not_running"
    stopped = subprocess.run([str(pg_ctl), "-D", str(directory), "-m", "immediate", "-w", "-t", "10", "stop"], capture_output=True, timeout=15, env=env)
    # A launcher timeout/failure is not evidence of postmaster completion.
    observed = subprocess.run([str(pg_ctl), "-D", str(directory), "status"], capture_output=True, timeout=5, env=env)
    return "stopped_after_failure" if stopped.returncode == 0 and observed.returncode == 3 else "cleanup_unconfirmed"


def main():
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
    directory = ROOT / "workflow-artifacts/verification/B02/G1/gates" / stamp
    directory.mkdir(parents=True)
    report = {"kind": "ifpmic_b02_g1_frozen_candidate", "started_at": now(), "verdict": "running",
              "scope": "G1 local Python dependency, PostgreSQL toolchain, migrations and DB privileges only; no G2-G7, original AT or real SSO acceptance."}
    try:
        if digest(ROOT / "docs/ifpmic/B02-IDENTITY.md") != EXPECTED_PLAN:
            raise RuntimeError("Approved plan changed")
        for name in ("plan-review-v3.json", "tc-plan-review-v3.json"):
            review = json.loads((ROOT / "docs/ifpmic/evidence/b02" / name).read_text())
            if review["reviewed_plan"]["sha256"] != EXPECTED_PLAN or not review["decision"].startswith("approve"):
                raise RuntimeError("Independent plan approval missing")
        report["source_hashes"] = sources()
        report["source_fingerprint"] = sha256(json.dumps(report["source_hashes"], sort_keys=True).encode()).hexdigest()
        report["environment"] = check_environment()
        report["unchanged_existing_sources"] = check_unchanged_sources()
        command = [sys.executable, "-m", "pytest", "-q", "tests/ifpmic_api", "--junitxml", str(directory / "pytest.xml")]
        report["pytest"] = {"command": [".ifpmic-venv/bin/python", *command[1:3], "-q", "tests/ifpmic_api", "--junitxml", "<gate>/pytest.xml"], "started_at": now(), "timeout_seconds": 300}
        lifecycle_path = directory / "private-lifecycle.json"
        try:
            completed = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=300,
                                       env={**os.environ, "PYTHONPATH": str(ROOT), "IFPMIC_TEST_LIFECYCLE_PATH": str(lifecycle_path)})
        except subprocess.TimeoutExpired as error:
            (directory / "pytest.log").write_bytes((error.stdout or b"") + (error.stderr or b""))
            report["timeout_cleanup"] = cleanup_cluster(lifecycle_path)
            raise RuntimeError("G1 pytest timeout; inspect retained lifecycle and process evidence") from None
        output = completed.stdout + completed.stderr
        (directory / "pytest.log").write_bytes(output)
        cases = ET.parse(directory / "pytest.xml").findall(".//testcase")
        counts = {"tests": len(cases), "failed": sum(c.find("failure") is not None for c in cases),
                  "errors": sum(c.find("error") is not None for c in cases), "skipped": sum(c.find("skipped") is not None for c in cases)}
        counts["passed"] = counts["tests"] - counts["failed"] - counts["errors"] - counts["skipped"]
        report["pytest"].update({"exit_code": completed.returncode, "finished_at": now(), "counts": counts,
                                 "log_sha256": sha256(output).hexdigest(), "junit_sha256": digest(directory / "pytest.xml")})
        if completed.returncode != 0 or counts["tests"] < 9 or counts["passed"] != counts["tests"]:
            report["failure_cleanup"] = cleanup_cluster(lifecycle_path)
            raise RuntimeError("All G1 tests must pass without skips")
        lifecycle = json.loads(lifecycle_path.read_text())
        if lifecycle["stop_status"] != "stopped" or lifecycle["pid_alive"] is not False:
            report["failure_cleanup"] = cleanup_cluster(lifecycle_path)
            raise RuntimeError("Fixture PostgreSQL shutdown not verified")
        operations = lifecycle["lifecycle"]
        if not operations or any(item["exit_code"] != 0 for item in operations):
            raise RuntimeError("Fixture lifecycle operation failed")
        report["postgres_lifecycle"] = {"stop_status": lifecycle["stop_status"], "pid_alive_after_stop": lifecycle["pid_alive"],
                                         "binary_versions": lifecycle["binary_versions"], "binary_sha256": lifecycle["binary_sha256"],
                                         "operations": operations, "private_manifest_excluded_from_publication": True}
        after = sources()
        changed = [p for p in report["source_hashes"].keys() | after.keys() if report["source_hashes"].get(p) != after.get(p)]
        report["source_changes"] = sorted(changed)
        if changed:
            raise RuntimeError("Candidate changed during verification")
        report["verdict"] = "pass"
    except Exception as error:
        report["verdict"] = "fail"
        report["finding"] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print("G1 candidate failed; inspect its retained gate evidence.")
    finally:
        report["finished_at"] = now()
        (directory / "gate.json").write_text(json.dumps(report, indent=2) + "\n")
        print(f"G1 {report['verdict']}: {(directory / 'gate.json').relative_to(ROOT)}")
    return 0 if report["verdict"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
