"""Phase 2 UNDO-02 — Diff-log append endpoint.

POST /agentic/diff-log/append
    body: { project_id: str, event: DiffEvent-shaped dict }

Writes a single JSON line to ``<PROJECT_DATA_DIR>/<project_id>.diff-log.jsonl``.

Guarantees:
    * Project-id format allowlisted (no path traversal)
    * Payload capped (64 KB / 500 patches) to blunt obvious DoS
    * fsync on every append — durability against mid-write crash
    * Parent dir auto-created
    * Append-only; never rewrites existing lines
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, ValidationError

_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
_MAX_PAYLOAD_BYTES = 64 * 1024  # 64 KB per event
_MAX_PATCHES = 500

PROJECT_DATA_DIR = Path(os.environ.get("PROJECT_DATA_DIR", "project_data")).resolve()


class DiffPatch(BaseModel):
    op: str
    path: str
    value: Optional[Any] = None
    # `from` is a reserved word in Python — use alias.
    from_: Optional[str] = Field(default=None, alias="from")


class DiffEventModel(BaseModel):
    v: Literal[1]
    ts: str
    project_id: str
    session_id: str
    cause: str
    patches: List[DiffPatch]
    scrubber_ids: List[str] = Field(default_factory=list)
    pin: Optional[Literal["permanent", "one-off"]] = None
    meta: Optional[Dict[str, Any]] = None


class AppendRequest(BaseModel):
    project_id: str
    event: DiffEventModel


router = APIRouter(prefix="/agentic", tags=["agentic-mode"])


def _validate_project_id(project_id: str) -> Path:
    if not _PROJECT_ID_RE.match(project_id):
        raise HTTPException(400, detail="project_id format invalid")
    path = (PROJECT_DATA_DIR / f"{project_id}.diff-log.jsonl").resolve()
    try:
        path.relative_to(PROJECT_DATA_DIR)
    except ValueError:
        raise HTTPException(400, detail="project_id resolved outside data dir")
    return path


def _append_jsonl(path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Open in append mode; fsync on close for durability.
    with open(path, "a", encoding="utf-8") as f:
        f.write(line)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())


@router.post("/diff-log/append", status_code=204)
async def append_diff_log(req: AppendRequest) -> None:  # pragma: no cover - thin wrapper
    target = _validate_project_id(req.project_id)

    if len(req.event.patches) > _MAX_PATCHES:
        raise HTTPException(413, detail=f"patches > {_MAX_PATCHES}")

    try:
        # Model -> dict with aliased keys (by_alias=True rebuilds `from`)
        payload = req.event.model_dump(by_alias=True, exclude_none=True)
    except ValidationError as e:
        raise HTTPException(422, detail=e.errors())

    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(line.encode("utf-8")) > _MAX_PAYLOAD_BYTES:
        raise HTTPException(413, detail=f"event > {_MAX_PAYLOAD_BYTES} bytes")

    _append_jsonl(target, line)
    return None
