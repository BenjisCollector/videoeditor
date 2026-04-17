// Phase 2 UNDO-01 — React hook wrapping the pure diff emitter.
//
// Responsibilities:
//   * Caller invokes beginCommit(cause, pin?) BEFORE the state mutation that
//     should be captured as a single atomic event. The hook deep-clones the
//     current timeline as the "before" snapshot.
//   * An effect on the timeline watches for the first state where no scrubber
//     is_dragging (drag-boundary flush). When that happens AND a commit is
//     pending, it computes the diff and posts it.
//   * This avoids the 60+ micro-events-per-drag problem: mouse-move emits
//     never fire the diff; only the mouseup-settled state does.

import { useCallback, useEffect, useRef } from "react";
import {
  computeDiffEvent,
  postDiffEvent,
  type MinimalTimelineState,
} from "../lib/agentic-mode/diff-emitter.client.js";

type Pin = "permanent" | "one-off";

interface BeginCommitOptions {
  cause: string;
  pin?: Pin;
  meta?: Record<string, unknown>;
}

export interface UseDiffEmitterResult {
  beginCommit: (opts: BeginCommitOptions) => void;
}

interface ScrubberWithDrag {
  id: string;
  is_dragging?: boolean;
  [k: string]: unknown;
}

function anyScrubberDragging(t: MinimalTimelineState): boolean {
  for (const track of t.tracks) {
    for (const s of track.scrubbers) {
      if ((s as ScrubberWithDrag).is_dragging) return true;
    }
  }
  return false;
}

const deepClone = <T>(obj: T): T => JSON.parse(JSON.stringify(obj)) as T;

export function useDiffEmitter<T extends MinimalTimelineState>(
  timeline: T,
  projectId: string,
  sessionId: string,
  agenticMode: boolean,
): UseDiffEmitterResult {
  const beforeRef = useRef<T | null>(null);
  const causeRef = useRef<string | null>(null);
  const pinRef = useRef<Pin | undefined>(undefined);
  const metaRef = useRef<Record<string, unknown> | undefined>(undefined);
  const pendingRef = useRef(false);

  const beginCommit = useCallback(
    (opts: BeginCommitOptions) => {
      if (!agenticMode) return;
      beforeRef.current = deepClone(timeline);
      causeRef.current = opts.cause;
      pinRef.current = opts.pin;
      metaRef.current = opts.meta;
      pendingRef.current = true;
    },
    [agenticMode, timeline],
  );

  useEffect(() => {
    if (!agenticMode) return;
    if (!pendingRef.current || !beforeRef.current) return;
    if (anyScrubberDragging(timeline)) return; // defer until drag ends

    const ev = computeDiffEvent({
      before: beforeRef.current,
      after: timeline,
      projectId,
      sessionId,
      cause: causeRef.current ?? "unknown",
      pin: pinRef.current,
      meta: metaRef.current,
    });

    // Always reset — even if ev is null (no change).
    beforeRef.current = null;
    causeRef.current = null;
    pinRef.current = undefined;
    metaRef.current = undefined;
    pendingRef.current = false;

    if (ev) void postDiffEvent(projectId, ev);
  }, [timeline, agenticMode, projectId, sessionId]);

  return { beginCommit };
}
