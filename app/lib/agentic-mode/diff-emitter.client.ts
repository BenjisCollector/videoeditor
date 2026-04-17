// Phase 2 UNDO-01 — Pure diff computation.
//
// This module has NO React, NO fetch, NO side effects. It takes two
// TimelineState snapshots (before/after) and returns a structured DiffEvent
// (or null if nothing changed). The host code (useDiffEmitter hook or a
// backend worker) is responsible for persistence.
//
// Uses rfc6902 — the correct library for diffing two independent snapshots.
// (Mutative's enablePatches requires a producer function; it would force us
// to rewrite Kimu's state management. Research correction #1, PROJECT.md.)

import { createPatch, type Operation } from "rfc6902";

// Minimal TimelineState shape we need for diff + id extraction.
// Intentionally decoupled from Kimu's app types to keep this lib testable in
// isolation.
export interface MinimalScrubber {
  id: string;
  [key: string]: unknown;
}
export interface MinimalTrack {
  id?: string;
  scrubbers: MinimalScrubber[];
}
export interface MinimalTimelineState {
  tracks: MinimalTrack[];
}

export interface ComputeDiffEventInput<T extends MinimalTimelineState = MinimalTimelineState> {
  before: T;
  after: T;
  projectId: string;
  sessionId: string;
  cause: string;
  pin?: "permanent" | "one-off";
  meta?: Record<string, unknown>;
}

export interface DiffEvent {
  v: 1;
  ts: string;
  project_id: string;
  session_id: string;
  cause: string;
  patches: Operation[];
  scrubber_ids: string[];
  pin?: "permanent" | "one-off";
  meta?: Record<string, unknown>;
}

const SCRUBBER_PATH_RE = /^\/tracks\/(\d+)\/scrubbers\/(\d+)(?:\/.*)?$/;

/**
 * extractScrubberIds — parses RFC 6902 patch paths to find which scrubber
 * ids changed. Pulls from `after` by default; falls back to `before` for
 * removal ops that no longer exist in `after`.
 */
export function extractScrubberIds(
  patches: Operation[],
  after: MinimalTimelineState,
  before?: MinimalTimelineState,
): string[] {
  const ids = new Set<string>();
  for (const op of patches) {
    const m = SCRUBBER_PATH_RE.exec(op.path);
    if (!m) continue;
    const trackIdx = Number(m[1]);
    const scrubIdx = Number(m[2]);
    const afterScrubber = after.tracks[trackIdx]?.scrubbers[scrubIdx];
    if (afterScrubber?.id) {
      ids.add(afterScrubber.id);
      continue;
    }
    const beforeScrubber = before?.tracks[trackIdx]?.scrubbers[scrubIdx];
    if (beforeScrubber?.id) ids.add(beforeScrubber.id);
  }
  return Array.from(ids);
}

/**
 * computeDiffEvent — returns a DiffEvent if anything changed, else null.
 *
 * Pure function. Same (before, after, cause, ...) yields the same output.
 * Patches follow RFC 6902.
 */
export function computeDiffEvent<T extends MinimalTimelineState>(
  input: ComputeDiffEventInput<T>,
): DiffEvent | null {
  const patches = createPatch(input.before, input.after);
  if (patches.length === 0) return null;
  const scrubber_ids = extractScrubberIds(patches, input.after, input.before);
  const ev: DiffEvent = {
    v: 1,
    ts: new Date().toISOString(),
    project_id: input.projectId,
    session_id: input.sessionId,
    cause: input.cause,
    patches,
    scrubber_ids,
  };
  if (input.pin) ev.pin = input.pin;
  if (input.meta) ev.meta = input.meta;
  return ev;
}

/**
 * postDiffEvent — thin fetch wrapper for the loopback-only backend endpoint.
 *
 * Extracted so tests can stub it via `vi.stubGlobal("fetch", ...)` rather
 * than mock the whole client.
 */
export const DIFF_LOG_URL = "http://127.0.0.1:8000/agentic/diff-log/append";

export async function postDiffEvent(
  projectId: string,
  event: DiffEvent,
): Promise<void> {
  const res = await fetch(DIFF_LOG_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: projectId, event }),
  });
  if (!res.ok) {
    throw new Error(`postDiffEvent: ${res.status}`);
  }
}
