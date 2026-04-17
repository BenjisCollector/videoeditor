"""Integration tests for /agentic/diff-log/append."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# Swap PROJECT_DATA_DIR via env BEFORE importing the router so module-level
# constants pick up the tmp path.
TMP_DIR: Path
app: FastAPI
client: TestClient


@pytest.fixture(autouse=True)
def _tmpdir(tmp_path, monkeypatch):
    global TMP_DIR, app, client
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path))
    # Reimport the module so PROJECT_DATA_DIR reflects the new env var.
    import importlib
    import backend.diff_log_api as mod

    importlib.reload(mod)
    TMP_DIR = tmp_path
    app = FastAPI()
    app.include_router(mod.router)
    client = TestClient(app)
    yield


def _minimal_event(project_id: str = "p1"):
    return {
        "v": 1,
        "ts": "2026-04-17T00:00:00Z",
        "project_id": project_id,
        "session_id": "s1",
        "cause": "scrubber.update",
        "patches": [{"op": "replace", "path": "/tracks/0/scrubbers/0/left", "value": 50}],
        "scrubber_ids": ["clip-abc"],
    }


def test_append_writes_one_jsonl_line():
    r = client.post(
        "/agentic/diff-log/append",
        json={"project_id": "p1", "event": _minimal_event()},
    )
    assert r.status_code == 204
    target = TMP_DIR / "p1.diff-log.jsonl"
    assert target.exists()
    lines = target.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    parsed = json.loads(lines[0])
    assert parsed["project_id"] == "p1"
    assert parsed["scrubber_ids"] == ["clip-abc"]


def test_twenty_sequential_appends_yield_twenty_lines():
    for i in range(20):
        ev = _minimal_event()
        ev["session_id"] = f"s{i}"
        r = client.post("/agentic/diff-log/append", json={"project_id": "p1", "event": ev})
        assert r.status_code == 204
    lines = (TMP_DIR / "p1.diff-log.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 20


def test_rejects_path_traversal_in_project_id():
    ev = _minimal_event(project_id="../etc")
    r = client.post("/agentic/diff-log/append", json={"project_id": "../etc", "event": ev})
    assert r.status_code == 400


def test_rejects_oversize_patches_list():
    ev = _minimal_event()
    ev["patches"] = [
        {"op": "replace", "path": f"/x/{i}", "value": 1} for i in range(501)
    ]
    r = client.post("/agentic/diff-log/append", json={"project_id": "p1", "event": ev})
    assert r.status_code == 413


def test_rejects_bad_project_id_format():
    ev = _minimal_event(project_id="bad id!")
    r = client.post("/agentic/diff-log/append", json={"project_id": "bad id!", "event": ev})
    assert r.status_code == 400


def test_preserves_from_field_alias_for_move_ops():
    ev = _minimal_event()
    ev["patches"] = [{"op": "move", "from": "/a", "path": "/b"}]
    r = client.post("/agentic/diff-log/append", json={"project_id": "p1", "event": ev})
    assert r.status_code == 204
    parsed = json.loads((TMP_DIR / "p1.diff-log.jsonl").read_text().splitlines()[0])
    assert parsed["patches"][0]["from"] == "/a"


def test_pin_and_meta_round_trip():
    ev = _minimal_event()
    ev["pin"] = "permanent"
    ev["meta"] = {"note": "keep this"}
    r = client.post("/agentic/diff-log/append", json={"project_id": "p1", "event": ev})
    assert r.status_code == 204
    parsed = json.loads((TMP_DIR / "p1.diff-log.jsonl").read_text().splitlines()[0])
    assert parsed["pin"] == "permanent"
    assert parsed["meta"] == {"note": "keep this"}


def test_one_off_pin_value_accepted():
    ev = _minimal_event()
    ev["pin"] = "one-off"
    r = client.post("/agentic/diff-log/append", json={"project_id": "p1", "event": ev})
    assert r.status_code == 204


def test_unknown_pin_value_rejected():
    ev = _minimal_event()
    ev["pin"] = "whatever"
    r = client.post("/agentic/diff-log/append", json={"project_id": "p1", "event": ev})
    assert r.status_code == 422
