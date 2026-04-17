import { describe, it, expect, vi } from "vitest";
import {
  computeDiffEvent,
  extractScrubberIds,
  postDiffEvent,
  DIFF_LOG_URL,
  type MinimalTimelineState,
} from "../diff-emitter.client.js";

// Tiny fixture helpers — avoid importing Kimu types so this stays portable.
function mkTimeline(
  scrubbers: Array<{ id: string; left?: number }>,
): MinimalTimelineState {
  return {
    tracks: [
      {
        scrubbers: scrubbers.map((s) => ({
          id: s.id,
          left: s.left ?? 0,
          mediaType: "video",
        })),
      },
    ],
  };
}

describe("computeDiffEvent", () => {
  it("returns a DiffEvent with RFC 6902 patches when state changes", () => {
    const before = mkTimeline([{ id: "a", left: 0 }]);
    const after = mkTimeline([{ id: "a", left: 50 }]);
    const ev = computeDiffEvent({
      before,
      after,
      projectId: "p1",
      sessionId: "s1",
      cause: "scrubber.update",
    });
    expect(ev).not.toBeNull();
    expect(ev!.cause).toBe("scrubber.update");
    expect(ev!.patches).toContainEqual({
      op: "replace",
      path: "/tracks/0/scrubbers/0/left",
      value: 50,
    });
  });

  it("returns null when before === after (no patches)", () => {
    const t = mkTimeline([{ id: "a", left: 10 }]);
    const ev = computeDiffEvent({
      before: t,
      after: t,
      projectId: "p1",
      sessionId: "s1",
      cause: "noop",
    });
    expect(ev).toBeNull();
  });

  it("populates scrubber_ids from the patched paths", () => {
    const before = mkTimeline([
      { id: "a", left: 0 },
      { id: "b", left: 0 },
    ]);
    const after = mkTimeline([
      { id: "a", left: 50 },
      { id: "b", left: 0 },
    ]);
    const ev = computeDiffEvent({
      before,
      after,
      projectId: "p1",
      sessionId: "s1",
      cause: "scrubber.update",
    });
    expect(ev!.scrubber_ids).toEqual(["a"]);
  });

  it("carries pin + meta through when provided", () => {
    const before = mkTimeline([{ id: "a", left: 0 }]);
    const after = mkTimeline([{ id: "a", left: 50 }]);
    const ev = computeDiffEvent({
      before,
      after,
      projectId: "p1",
      sessionId: "s1",
      cause: "scrubber.update",
      pin: "permanent",
      meta: { note: "pinned" },
    });
    expect(ev!.pin).toBe("permanent");
    expect(ev!.meta).toEqual({ note: "pinned" });
  });

  it("sets v=1 and an ISO timestamp", () => {
    const before = mkTimeline([{ id: "a", left: 0 }]);
    const after = mkTimeline([{ id: "a", left: 1 }]);
    const ev = computeDiffEvent({
      before,
      after,
      projectId: "p1",
      sessionId: "s1",
      cause: "x",
    })!;
    expect(ev.v).toBe(1);
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });
});

describe("extractScrubberIds", () => {
  it("collapses duplicate paths from the same scrubber into one id", () => {
    const before = mkTimeline([{ id: "a", left: 0 }]);
    const after: MinimalTimelineState = {
      tracks: [
        {
          scrubbers: [
            {
              id: "a",
              left: 50,
              mediaType: "image",
            } as { id: string; [k: string]: unknown },
          ],
        },
      ],
    };
    const ev = computeDiffEvent({
      before,
      after,
      projectId: "p1",
      sessionId: "s1",
      cause: "scrubber.update",
    })!;
    expect(ev.scrubber_ids).toEqual(["a"]);
    expect(ev.patches.length).toBeGreaterThan(1);
  });

  it("falls back to before-snapshot id when scrubber was removed", () => {
    const before = mkTimeline([
      { id: "a", left: 0 },
      { id: "b", left: 0 },
    ]);
    const after = mkTimeline([{ id: "a", left: 0 }]);
    const ev = computeDiffEvent({
      before,
      after,
      projectId: "p1",
      sessionId: "s1",
      cause: "scrubber.delete",
    })!;
    expect(ev.scrubber_ids).toContain("b");
  });

  it("returns [] when patches touch no scrubber paths", () => {
    expect(
      extractScrubberIds(
        [{ op: "replace", path: "/unrelated/key", value: 1 }],
        { tracks: [] },
      ),
    ).toEqual([]);
  });
});

describe("postDiffEvent", () => {
  it("POSTs JSON to the loopback URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await postDiffEvent("p1", {
      v: 1,
      ts: "2026-04-17T00:00:00Z",
      project_id: "p1",
      session_id: "s1",
      cause: "x",
      patches: [],
      scrubber_ids: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      DIFF_LOG_URL,
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    vi.unstubAllGlobals();
  });

  it("throws when backend returns non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 500 })),
    );
    await expect(
      postDiffEvent("p1", {
        v: 1,
        ts: "2026-04-17T00:00:00Z",
        project_id: "p1",
        session_id: "s1",
        cause: "x",
        patches: [],
        scrubber_ids: [],
      }),
    ).rejects.toThrow(/500/);
    vi.unstubAllGlobals();
  });
});
