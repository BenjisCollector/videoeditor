import os
import json as _json
import re
import traceback
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict

import anthropic

from schema import FunctionCallResponse, UniversalToolCall
from tools_registry import get_tools_catalog

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5")
ANTHROPIC_MAX_TOKENS = int(os.getenv("ANTHROPIC_MAX_TOKENS", "1024"))

app = FastAPI()

# The client is created lazily so an unset API key surfaces as a 500 from the
# /ai endpoint rather than a startup crash, keeping other endpoints reachable
# for smoke tests.
_anthropic_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _anthropic_client
    if _anthropic_client is None:
        if not ANTHROPIC_API_KEY:
            raise HTTPException(
                status_code=500,
                detail="ANTHROPIC_API_KEY is not set in environment",
            )
        _anthropic_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    return _anthropic_client


# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Message(BaseModel):
    # Be permissive with incoming payloads from the frontend
    model_config = ConfigDict(extra="ignore")

    message: str  # the full user message
    mentioned_scrubber_ids: list[str] | None = None  # scrubber ids mentioned via '@'
    # Accept any shape for resilience; backend does not mutate these
    timeline_state: dict[str, Any] | None = None  # current timeline state
    mediabin_items: list[dict[str, Any]] | None = None  # current media bin
    chat_history: list[dict[str, Any]] | None = None  # prior turns: [{"role":"user"|"assistant","content":"..."}]


def _to_seconds(value: Any) -> float | None:
    """Best-effort conversion of a value to seconds (float).

    Supports numbers, "hh:mm[:ss]", and free-form like "1h 2m 3s", "90s", "2.5min".
    """
    if isinstance(value, (int, float)):
        try:
            v = float(value)
            if v == v:  # not NaN
                return v
        except Exception:
            return None
        return None
    if not isinstance(value, str):
        return None
    s = value.strip().lower()
    # hh:mm[:ss]
    if ":" in s:
        parts = [p for p in s.split(":") if p != ""]
        try:
            if len(parts) == 2:
                m, sec = float(parts[0]), float(parts[1])
                return m * 60 + sec
            if len(parts) == 3:
                h, m, sec = float(parts[0]), float(parts[1]), float(parts[2])
                return h * 3600 + m * 60 + sec
        except Exception:
            pass
    # 1h2m3s / 2m / 90s etc.
    # Bounded quantifiers and longest-unit-first ordering prevent polynomial backtracking.
    total = 0.0
    matched = False
    for m in re.finditer(r"(?P<num>[0-9]{1,15}(?:\.[0-9]{1,10})?)[ ]?(?P<unit>milliseconds|millisecond|minutes|minute|seconds|second|hours|hour|secs|mins|hrs|min|sec|ms|hr|m|s|h)\b",
                         s):
        matched = True
        num = float(m.group("num"))
        unit = m.group("unit")
        if unit in {"h", "hr", "hrs", "hour", "hours"}:
            total += num * 3600
        elif unit in {"m", "min", "mins", "minute", "minutes"}:
            total += num * 60
        elif unit in {"ms", "millisecond", "milliseconds"}:
            total += num / 1000.0
        else:  # seconds
            total += num
    if matched:
        return total
    # plain number fallback
    try:
        v = float(s)
        return v if v == v else None
    except Exception:
        return None


def _normalize_time_fields_from_text(user_text: str, args: dict[str, Any]) -> dict[str, Any]:
    """Fill or fix start_seconds / duration_seconds / end_seconds from the user text.

    - Detect patterns like "from 2s to 12s", "at 2s", "for 10s", "span for 10s".
    - Also detect variants like "to 12 seconds long", "12s long", "set to 12s", "make it 12s".
    - If duration and start are present but end is not, compute end.
    - If end and start present but duration absent, compute duration.
    """
    updated = dict(args or {})
    text = (user_text or "").lower()

    # Extract explicit FROM ... TO ... first
    # Use [0-9][0-9.]*[a-z]*(?:[ ][a-z]{1,12})? so the numeric, attached-unit, and
    # separated-unit character classes are disjoint - no ambiguous matching, no ReDoS.
    m = re.search(r"from\s+([0-9][0-9.]*[a-z]*(?:[ ][a-z]{1,12})?)\s+to\s+([0-9][0-9.]*[a-z]*(?:[ ][a-z]{1,12})?)", text)
    if m:
        start_candidate = _to_seconds(m.group(1))
        end_candidate = _to_seconds(m.group(2))
        if start_candidate is not None and updated.get("start_seconds") is None:
            updated["start_seconds"] = start_candidate
        if end_candidate is not None and updated.get("end_seconds") is None:
            updated["end_seconds"] = end_candidate

    # AT ... / START AT ... / FROM ... (single)
    m2 = re.search(r"(?:at|starting\s+at|start\s+at|from)\s+([0-9][0-9.]*[a-z]*(?:[ ][a-z]{1,12})?)", text)
    if m2 and updated.get("start_seconds") is None:
        start_candidate = _to_seconds(m2.group(1))
        if start_candidate is not None:
            updated["start_seconds"] = start_candidate

    # FOR ... / SPAN FOR ...
    m3 = re.search(r"(?:for|span(?:s)?\s+for)\s+([0-9][0-9.]*[a-z]*(?:[ ][a-z]{1,12})?)", text)
    if m3 and updated.get("duration_seconds") is None:
        dur_candidate = _to_seconds(m3.group(1))
        if dur_candidate is not None:
            updated["duration_seconds"] = dur_candidate

    # TO ... LONG / SET TO ... / MAKE (IT)? ...
    # Examples: "to 12 seconds long", "set to 12s", "make it 8 sec", "12s long"
    if updated.get("duration_seconds") is None:
        m4 = re.search(r"(?:to\s+)?([0-9][0-9.]*[a-z]*(?:[ ][a-z]{1,12})?)\s+long", text)
        if m4:
            dur_candidate = _to_seconds(m4.group(1))
            if dur_candidate is not None:
                updated["duration_seconds"] = dur_candidate
    if updated.get("duration_seconds") is None:
        m5 = re.search(r"(?:set\s+(?:it\s+)?to|make\s+(?:it\s+)?)\s+([0-9][0-9.]*[a-z]*(?:[ ][a-z]{1,12})?)", text)
        if m5:
            dur_candidate = _to_seconds(m5.group(1))
            if dur_candidate is not None:
                updated["duration_seconds"] = dur_candidate

    # Post-derivations
    start_val = _to_seconds(updated.get("start_seconds"))
    end_val = _to_seconds(updated.get("end_seconds"))
    dur_val = _to_seconds(updated.get("duration_seconds"))
    if start_val is not None and end_val is not None and dur_val is None:
        updated["duration_seconds"] = max(0.0, end_val - start_val)
    if start_val is not None and dur_val is not None and end_val is None:
        updated["end_seconds"] = max(0.0, start_val + dur_val)

    return updated


def _postprocess_response(user_text: str, resp: FunctionCallResponse) -> FunctionCallResponse:
    if resp and resp.function_call and isinstance(resp.function_call.arguments, dict):
        resp.function_call.arguments = _normalize_time_fields_from_text(user_text, resp.function_call.arguments)
    return resp


def _tools_for_anthropic() -> list[dict[str, Any]]:
    """Translate the provider-agnostic tool catalog into Anthropic tool-use shape.

    Anthropic expects:
        { "name": str, "description": str, "input_schema": JSONSchema }
    The catalog entries already carry a JSON-Schema-like `arguments` dict; we
    map `arguments -> input_schema` and pass `name`/`description` through.
    """
    tools: list[dict[str, Any]] = []
    for entry in get_tools_catalog():
        tools.append(
            {
                "name": entry["name"],
                "description": entry.get("description", ""),
                "input_schema": entry.get(
                    "arguments", {"type": "object", "properties": {}}
                ),
            }
        )
    return tools


# A virtual tool that lets the model respond with free-form assistant text when
# no concrete editor action applies. Having this as an explicit tool lets us
# force `tool_choice={"type": "any"}` and still get a clarification path.
_ASSISTANT_MESSAGE_TOOL: dict[str, Any] = {
    "name": "AssistantMessage",
    "description": (
        "Respond with a short assistant message when no concrete editor "
        "action applies, or when a clarifying question is required before "
        "taking an action. Use for ambiguous requests only."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "The assistant message to show to the user.",
            }
        },
        "required": ["message"],
    },
}


SYSTEM_PROMPT = """You are an AI assistant inside a video editor.

You will decide between calling exactly one tool to perform a concrete
edit, or calling the AssistantMessage tool with a short clarifying
question when the request is ambiguous or cannot be fulfilled safely.

Tool calling policy:
- Call ONE tool only when the user's request is clear and safe to execute.
- If ambiguous (e.g., no clear asset or time), call AssistantMessage with
  a concise clarifying question.
- Assume a single active timeline; do NOT require a timeline_id.
- Tracks are named like "track-1", but users say "track 1" meaning 1-based
  index.
- Default pixels_per_second = 100 if not provided.
- If user mentions items with @, prefer those exact assets (via
  mentioned_scrubber_ids). Otherwise, map names by case-insensitive
  substring to media bin items.

Editing semantics for time and duration:
- "at 2 sec" or "at 2s" -> start_seconds = 2.
- "for 10 sec" -> duration_seconds = 10.
- "from 2 sec for 10 sec" -> start_seconds = 2, duration_seconds = 10.
- "from 2 sec to 12 sec" -> start_seconds = 2, end_seconds = 12.
- If duration is omitted, use the media's intrinsic duration if available;
  for images default to 5 seconds.

Tool selection guidance:
- If the user references @<asset>, call AddMediaById using
  mentioned_scrubber_ids[0].
- If the user references an asset by name (e.g., "cardboard"), call
  AddMediaByName with scrubber_name="cardboard".
- If user asks to make it span for N seconds, prefer AddMedia* with
  duration_seconds.
- If user says "from A sec to B sec", pass start_seconds=A and end_seconds=B.
- For deletions like "remove everything on track 2", call
  DeleteScrubbersInTrack with track_number=2.
"""


def _build_messages(request: Message) -> list[dict[str, Any]]:
    """Convert the incoming request into Anthropic messages[] shape.

    Prior chat history (if present) is replayed as alternating user/assistant
    turns. The final user turn carries the structured editor context so the
    model has the latest timeline + media-bin state when choosing a tool.
    """
    messages: list[dict[str, Any]] = []

    for turn in request.chat_history or []:
        role = turn.get("role")
        content = turn.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content:
            messages.append({"role": role, "content": content})

    user_body = (
        f"User message: {request.message}\n"
        f"Mentioned scrubber ids: {request.mentioned_scrubber_ids}\n"
        f"Timeline state: {_json.dumps(request.timeline_state, separators=(',', ':')) if request.timeline_state is not None else 'null'}\n"
        f"Media bin items: {_json.dumps(request.mediabin_items, separators=(',', ':')) if request.mediabin_items is not None else 'null'}\n"
    )
    messages.append({"role": "user", "content": user_body})
    return messages


def _extract_tool_use(response: Any) -> tuple[str | None, dict[str, Any] | None, str | None]:
    """Pull the first tool_use block (if any) and any trailing text out of the
    Anthropic response.

    Returns: (tool_name, tool_input, text_fallback)
    """
    tool_name: str | None = None
    tool_input: dict[str, Any] | None = None
    text_fallback: str | None = None

    for block in getattr(response, "content", []) or []:
        btype = getattr(block, "type", None)
        if btype == "tool_use" and tool_name is None:
            tool_name = getattr(block, "name", None)
            raw_input = getattr(block, "input", {}) or {}
            tool_input = dict(raw_input) if isinstance(raw_input, dict) else {}
        elif btype == "text" and text_fallback is None:
            text_fallback = getattr(block, "text", None)

    return tool_name, tool_input, text_fallback


def _response_from_tool(tool_name: str, tool_input: dict[str, Any] | None) -> FunctionCallResponse:
    if tool_name == _ASSISTANT_MESSAGE_TOOL["name"]:
        msg = (tool_input or {}).get("message") or ""
        return FunctionCallResponse(assistant_message=str(msg))
    return FunctionCallResponse(
        function_call=UniversalToolCall(
            function_name=tool_name,
            arguments=tool_input or {},
        )
    )


@app.post("/ai")
async def process_ai_message(request: Message) -> FunctionCallResponse:
    try:
        client = _get_client()

        # Debug: incoming request summary
        try:
            print(
                "[AI] Incoming payload summary:",
                {
                    "message": request.message[:200] if request.message else None,
                    "mentioned_scrubber_ids": request.mentioned_scrubber_ids,
                    "timeline_state_present": request.timeline_state is not None,
                    "mediabin_count": len(request.mediabin_items or []),
                    "chat_history_count": len(request.chat_history or []),
                },
            )
        except Exception:
            pass

        tools = _tools_for_anthropic() + [_ASSISTANT_MESSAGE_TOOL]
        messages = _build_messages(request)

        response = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=ANTHROPIC_MAX_TOKENS,
            system=SYSTEM_PROMPT,
            tools=tools,
            # Force the model to call one of the available tools (which
            # includes AssistantMessage for ambiguous cases). Matches the
            # prior contract: always return either function_call or
            # assistant_message.
            tool_choice={"type": "any"},
            messages=messages,
        )

        try:
            print(
                "[AI] Response summary:",
                {
                    "stop_reason": getattr(response, "stop_reason", None),
                    "content_blocks": len(getattr(response, "content", []) or []),
                },
            )
        except Exception:
            pass

        tool_name, tool_input, text_fallback = _extract_tool_use(response)

        if tool_name is not None:
            resp = _response_from_tool(tool_name, tool_input)
            return _postprocess_response(request.message, resp)

        # Fallback: the model responded with only free-form text. Surface it
        # as an assistant_message so the frontend can render it unchanged.
        if text_fallback:
            return FunctionCallResponse(assistant_message=text_fallback)

        raise HTTPException(
            status_code=500,
            detail="Model returned no tool call and no text; enable debug logs for details",
        )
    except HTTPException:
        raise
    except Exception as e:
        # Print full traceback for debugging
        print("[AI] Error:", repr(e))
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e)) from e


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=3000)
