"""Read-only byte and output checks for the approved IFPMIC G6 baseline."""

from __future__ import annotations

import hashlib
import json
import stat
import subprocess
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BASELINE_PATH = "docs/ifpmic/evidence/b02/g6-source-baseline.json"
BASELINE_SHA256 = "e6f8a41f1b33b21e4e903636eb2c404d6ef0da95b673294f5d17b686cf38d8bf"
CONTRACT_PATH = "docs/ifpmic/evidence/b02/g6-execution-contract-v2.json"
CONTRACT_SHA256 = "e45256f8f942046645af1f61cbc3c91a504780cb3d8c408a8d35702753c8cd63"


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _baseline() -> dict[str, Any]:
    return json.loads((ROOT / BASELINE_PATH).read_text(encoding="utf-8"))


def _ordinary_files(directory: Path) -> list[Path]:
    if not directory.exists():
        return []
    files: list[Path] = []
    for path in directory.rglob("*"):
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            continue
        if not stat.S_ISREG(mode):
            raise ValueError(f"non-ordinary inventory entry: {path.relative_to(ROOT)}")
        files.append(path)
    return sorted(files)


def source_hashes() -> dict[str, str]:
    """Hash the accepted 334-source union plus current relevant sources."""
    baseline = _baseline()
    paths = set(baseline["source_inventory"]["files"])

    roots = ("src", "server", "plugins", "scripts", "tests", "runtime", "services")
    for root in roots:
        for path in _ordinary_files(ROOT / root):
            if "__pycache__" in path.parts or ".pytest_cache" in path.parts:
                continue
            if path.suffix == ".pyc":
                continue
            paths.add(path.relative_to(ROOT).as_posix())

    for path in _ordinary_files(ROOT / "docs/ifpmic/design-v1"):
        paths.add(path.relative_to(ROOT).as_posix())

    for directory in (ROOT / "docs/ifpmic/evidence/b01", ROOT / "docs/ifpmic/evidence/b02"):
        for path in _ordinary_files(directory):
            if path.suffix == ".json":
                paths.add(path.relative_to(ROOT).as_posix())

    paths.update(
        {
            ".gitignore",
            "README.md",
            "package.json",
            "package-lock.json",
            "vite.config.ts",
            "tsconfig.json",
            "index.html",
            "ifpmic.html",
            "docs/ifpmic/PLAN.md",
            "docs/ifpmic/VERIFICATION.md",
            "docs/ifpmic/B02-IDENTITY.md",
            "docs/ifpmic/progress.json",
            "docs/ifpmic/source-manifest.json",
            "docs/ifpmic/evidence/plan-review.json",
        }
    )

    result: dict[str, str] = {}
    for relative in sorted(paths):
        path = ROOT / relative
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            raise FileNotFoundError(f"required source missing: {relative}") from None
        if not stat.S_ISREG(mode):
            raise ValueError(f"required source is not an ordinary file: {relative}")
        result[relative] = digest(path.read_bytes())
    return result


def output_hashes() -> dict[str, str]:
    """Return every ordinary file in both accepted build output trees."""
    result: dict[str, str] = {}
    for directory in (ROOT / "dist", ROOT / ".paperclip-lab/ifpmic-plugin"):
        for path in _ordinary_files(directory):
            relative = path.relative_to(ROOT).as_posix()
            result[relative] = digest(path.read_bytes())
    return dict(sorted(result.items()))


def tool_hashes() -> dict[str, str]:
    """Hash actual resolved package files recorded by the accepted baseline."""
    modules = _baseline()["dependency_resolution"]["package_files"]["actual_resolved_modules"]
    result: dict[str, str] = {}
    for module in modules.values():
        records = [module["package_json"], *module["resolved_files"]]
        for record in records:
            path = record["path"]
            file_path = ROOT / path
            if file_path.is_file():
                result[path] = digest(file_path.read_bytes())
    return dict(sorted(result.items()))


def _git_blob(commit: str, path: str) -> str | None:
    try:
        raw = subprocess.run(
            ["git", "show", f"{commit}:{path}"],
            cwd=ROOT,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=10,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    return digest(raw)


def _archive_gate_hash(archive_path: str) -> str | None:
    try:
        with zipfile.ZipFile(ROOT / archive_path) as archive:
            name = "gate.json" if "gate.json" in archive.namelist() else "gate/gate.json"
            return digest(archive.read(name))
    except (OSError, KeyError, zipfile.BadZipFile):
        return None


def _checks() -> tuple[dict[str, Any], dict[str, Any]]:
    baseline = _baseline()
    source_map = source_hashes()
    output_map = output_hashes()
    tools = tool_hashes()
    failures: list[str] = []

    if digest((ROOT / BASELINE_PATH).read_bytes()) != BASELINE_SHA256:
        failures.append("baseline_artifact_pin")
    if digest((ROOT / CONTRACT_PATH).read_bytes()) != CONTRACT_SHA256:
        failures.append("contract_artifact_pin")

    accepted_sources = baseline["source_inventory"]["files"]
    mismatched_sources = {
        path: {"accepted": expected, "current": source_map.get(path)}
        for path, expected in accepted_sources.items()
        if source_map.get(path) != expected
    }
    if len(accepted_sources) != 334:
        failures.append("accepted_source_count")
    if mismatched_sources:
        failures.append("accepted_source_bytes")

    ui = baseline["conditional_ui_omission"]
    relevant = ui["accepted_ui_server_plugin_sources"]["inventory"]
    additional = ui["additional_build_html_config_sources"]["inventory"]
    relevant_sources = {**relevant, **additional}
    source_delta: dict[str, Any] = {}
    for path, record in relevant_sources.items():
        expected = record.get("current_sha256")
        actual = source_map.get(path)
        controls = record.get("controls_baseline_sha256")
        b01 = record.get("b01_gate_sha256")
        if actual != expected or expected != controls or expected != b01:
            source_delta[path] = {"current": actual, "baseline": expected}
    actual_ui_paths = {
        path.relative_to(ROOT).as_posix()
        for root in ("src", "server", "plugins")
        for path in _ordinary_files(ROOT / root)
        if "__pycache__" not in path.parts
        and ".pytest_cache" not in path.parts
        and path.suffix != ".pyc"
    }
    actual_ui_delta = {
        "missing": sorted(set(relevant) - actual_ui_paths),
        "extra": sorted(actual_ui_paths - set(relevant)),
    }
    if len(relevant_sources) != 51 or source_delta or any(actual_ui_delta.values()):
        failures.append("relevant_source_inventory")

    expected_outputs = {
        path: record["accepted_sha256"]
        for path, record in ui["accepted_outputs_current_prebuild"].items()
    }
    output_delta = {
        path: {"accepted": expected, "current": output_map.get(path)}
        for path, expected in expected_outputs.items()
        if output_map.get(path) != expected
    }
    extras = sorted(set(output_map) - set(expected_outputs))
    missing = sorted(set(expected_outputs) - set(output_map))
    if len(expected_outputs) != 10 or output_delta or extras or missing:
        failures.append("accepted_output_inventory")

    package_records = baseline["dependency_resolution"]["package_files"]
    package_checks: dict[str, Any] = {}
    for path, record in package_records.items():
        if not isinstance(record, dict) or "b01_commit_sha256" not in record:
            continue
        actual = source_map.get(path)
        if actual != record["b01_commit_sha256"]:
            failures.append(f"accepted_package_file:{path}")
        package_checks[path] = {"current": actual, "accepted_b01": record["b01_commit_sha256"]}

    lock_path = ROOT / "package-lock.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    lock_packages = lock.get("packages", {})
    if len(lock_packages) != baseline["dependency_resolution"]["package_files"]["package-lock.json"]["locked_package_record_count"]:
        failures.append("lock_record_count")
    controls_commit = baseline["review_context"]["controls_commit"]
    old_lock = json.loads(
        subprocess.run(
            ["git", "show", f"{controls_commit}:package-lock.json"],
            cwd=ROOT,
            check=True,
            stdout=subprocess.PIPE,
            timeout=10,
        ).stdout
    )
    old_packages = old_lock.get("packages", {})
    expected_new = baseline["dependency_resolution"]["package_files"]["controls_to_b01"]["new_package_records"]
    added = {key: value for key, value in lock_packages.items() if key not in old_packages}
    if len(added) != len(expected_new):
        failures.append("controls_lock_additions")
    changed_existing = [
        key for key, value in old_packages.items()
        if key and key in lock_packages and lock_packages[key] != value
    ]
    removed = [key for key in old_packages if key not in lock_packages]
    if changed_existing or removed:
        failures.append("controls_lock_existing_records")
    for name, expected in expected_new.items():
        record = lock_packages.get(f"node_modules/{name}")
        if not record or record.get("version") != expected["version"] or record.get("integrity") != expected["integrity"]:
            failures.append(f"new_lock_pin:{name}")
    root_dependencies = lock_packages.get("", {}).get("dependencies", {})
    root_dev_dependencies = lock_packages.get("", {}).get("devDependencies", {})
    manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    if root_dependencies != manifest.get("dependencies", {}) or root_dev_dependencies != manifest.get("devDependencies", {}):
        failures.append("root_lock_dependencies")

    installed_deltas: dict[str, Any] = {}
    current_tools = tool_hashes()
    modules = baseline["dependency_resolution"]["package_files"]["actual_resolved_modules"]
    for path, expected in current_tools.items():
        record = next(
            (file for module in modules.values()
             for file in [module["package_json"], *module["resolved_files"]] if file["path"] == path),
            None,
        )
        if record and expected != record["sha256"]:
            installed_deltas[path] = {"accepted": record["sha256"], "current": expected}
    if installed_deltas or len(current_tools) != sum(
        1 + len(module["resolved_files"])
        for module in modules.values()
    ):
        failures.append("installed_tool_bytes")

    artifact_deltas: dict[str, Any] = {}
    for path, expected in baseline["artifact_pins"].items():
        actual = digest((ROOT / path).read_bytes()) if (ROOT / path).is_file() else None
        if actual != expected:
            artifact_deltas[path] = {"accepted": expected, "current": actual}
    for key in ("controls", "b01", "g5"):
        accepted = baseline["accepted_baselines"][key]
        archive = accepted["archive"]
        if _archive_gate_hash(archive["path"]) != archive["gate_entry_sha256"]:
            artifact_deltas[f"{key}:embedded_gate"] = {"accepted": archive["gate_entry_sha256"]}
    if artifact_deltas:
        failures.append("pinned_artifacts")

    b01 = baseline["accepted_baselines"]["b01"]
    g5 = baseline["accepted_baselines"]["g5"]
    b01_review = json.loads((ROOT / "docs/ifpmic/evidence/b01/final-review.json").read_text())
    g5_verification = json.loads((ROOT / "docs/ifpmic/evidence/b02/g5-verification.json").read_text())
    g5_review = json.loads((ROOT / "docs/ifpmic/evidence/b02/g5-final-review.json").read_text())
    if b01_review.get("decision") != "accept_partial_local_library_cli_candidate":
        failures.append("b01_review_decision")
    if g5_verification.get("gate_archive", {}).get("sha256") != g5["archive"]["sha256"]:
        failures.append("g5_verification_archive_pin")
    if g5_review.get("reviewed_pins", {}).get("gate_archive", {}).get("sha256") != g5["archive"]["sha256"]:
        failures.append("g5_review_archive_pin")

    # The accepted 135-source G5 capture is embedded in the frozen gate report.
    g5_gate: dict[str, Any] = {}
    try:
        with zipfile.ZipFile(ROOT / g5["archive"]["path"]) as archive:
            name = "gate.json" if "gate.json" in archive.namelist() else "gate/gate.json"
            g5_gate = json.loads(archive.read(name))
    except (OSError, KeyError, zipfile.BadZipFile, json.JSONDecodeError):
        failures.append("g5_gate_read")
    captured = g5_gate.get("sourceHashes", g5_gate.get("source_hashes", {}))
    if isinstance(captured, dict) and captured:
        captured_delta = {
            path: {"accepted": expected, "current": source_map.get(path)}
            for path, expected in captured.items()
            if source_map.get(path) != expected
        }
    else:
        captured_delta = {}
        failures.append("g5_source_map_missing")
    if len(captured) != 135 or captured_delta:
        failures.append("g5_source_map")

    search_patterns = ui["frontend_connection_search"]["searched_literals"]
    search_matches: list[str] = []
    for directory in (ROOT / "src", ROOT / "server", ROOT / "plugins"):
        for path in _ordinary_files(directory):
            if path.suffix == ".pyc" or "__pycache__" in path.parts or ".pytest_cache" in path.parts:
                continue
            content = path.read_bytes()
            for pattern in search_patterns:
                if pattern.encode("utf-8") in content:
                    search_matches.append(f"{path.relative_to(ROOT).as_posix()}:{pattern}")

    checks = {
        "failures": failures,
        "source_count": len(source_map),
        "accepted_source_count": len(accepted_sources),
        "accepted_source_delta": mismatched_sources,
        "relevant_source_count": len(relevant_sources),
        "relevant_source_delta": source_delta,
        "actual_ui_source_count": len(actual_ui_paths),
        "actual_ui_source_delta": actual_ui_delta,
        "output_count": len(output_map),
        "accepted_output_count": len(expected_outputs),
        "output_delta": output_delta,
        "output_extras": extras,
        "output_missing": missing,
        "package_files": package_checks,
        "lock_record_count": len(lock_packages),
        "lock_added_record_count": len(added),
        "lock_existing_changed": changed_existing,
        "lock_removed": removed,
        "installed_tool_delta": installed_deltas,
        "artifact_delta": artifact_deltas,
        "g5_source_count": len(captured),
        "g5_source_delta": captured_delta,
        "frontend_connection_matches": len(search_matches),
        "frontend_connection_match_locations": search_matches,
        "no_ui_connection_evidence": not search_matches,
    }
    maps = {"sources": source_map, "outputs": output_map, "tools": tools}
    return checks, maps


def check_baseline() -> dict[str, Any]:
    """Return a safe, recomputed baseline summary without source contents."""
    try:
        checks, maps = _checks()
        return {"ok": not checks["failures"], **checks, **maps}
    except Exception as exc:  # A failed read/check is a closed gate.
        return {"ok": False, "failures": [f"baseline_check_error:{type(exc).__name__}"]}
