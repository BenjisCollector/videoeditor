// @vitest-environment happy-dom
// Phase 2 UNDO-01 — drag-dedupe hook tests.
//
// Proves that 60+ mid-drag rerenders produce ONE diff event, fired at the
// drag-boundary (first frame where no scrubber has is_dragging=true).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDiffEmitter } from "../useDiffEmitter.js";
import type { MinimalTimelineState } from "../../lib/agentic-mode/diff-emitter.client.js";

interface ScrubberFx {
  id: string;
  left: number;
  is_dragging: boolean;
}

function mkT(scrubbers: ScrubberFx[]): MinimalTimelineState {
  return {
    tracks: [{ scrubbers: scrubbers.map((s) => ({ ...s })) }],
  };
}

describe("useDiffEmitter drag-dedupe", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function flush() {
    // Give the posted fetch a tick to resolve so expectations are stable.
    await Promise.resolve();
    await Promise.resolve();
  }

  it("one drag = one emit (60 is_dragging=true rerenders + 1 settled)", async () => {
    const initial = mkT([{ id: "a", left: 0, is_dragging: false }]);
    const { result, rerender } = renderHook(
      ({ t }) => useDiffEmitter(t, "p1", "s1", true),
      { initialProps: { t: initial } },
    );

    act(() => result.current.beginCommit({ cause: "scrubber.update" }));

    // 60 mid-drag rerenders — is_dragging=true, left slowly changing.
    for (let i = 1; i <= 60; i++) {
      rerender({ t: mkT([{ id: "a", left: i, is_dragging: true }]) });
    }
    // During the drag, nothing has been posted.
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    // Drag settles at left=60, is_dragging=false.
    rerender({ t: mkT([{ id: "a", left: 60, is_dragging: false }]) });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.project_id).toBe("p1");
    expect(body.event.cause).toBe("scrubber.update");
    expect(body.event.scrubber_ids).toEqual(["a"]);
  });

  it("no-op drag (before === after) emits nothing", async () => {
    const initial = mkT([{ id: "a", left: 10, is_dragging: false }]);
    const { result, rerender } = renderHook(
      ({ t }) => useDiffEmitter(t, "p1", "s1", true),
      { initialProps: { t: initial } },
    );
    act(() => result.current.beginCommit({ cause: "scrubber.update" }));

    rerender({ t: mkT([{ id: "a", left: 10, is_dragging: true }]) });
    rerender({ t: mkT([{ id: "a", left: 10, is_dragging: false }]) });

    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("two consecutive drags produce two emits", async () => {
    const initial = mkT([{ id: "a", left: 0, is_dragging: false }]);
    const { result, rerender } = renderHook(
      ({ t }) => useDiffEmitter(t, "p1", "s1", true),
      { initialProps: { t: initial } },
    );

    act(() => result.current.beginCommit({ cause: "scrubber.update" }));
    rerender({ t: mkT([{ id: "a", left: 10, is_dragging: true }]) });
    rerender({ t: mkT([{ id: "a", left: 20, is_dragging: false }]) });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => result.current.beginCommit({ cause: "scrubber.update" }));
    rerender({ t: mkT([{ id: "a", left: 30, is_dragging: true }]) });
    rerender({ t: mkT([{ id: "a", left: 40, is_dragging: false }]) });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("agenticMode=false is a no-op (never posts)", async () => {
    const initial = mkT([{ id: "a", left: 0, is_dragging: false }]);
    const { result, rerender } = renderHook(
      ({ t }) => useDiffEmitter(t, "p1", "s1", false),
      { initialProps: { t: initial } },
    );
    act(() => result.current.beginCommit({ cause: "scrubber.update" }));
    rerender({ t: mkT([{ id: "a", left: 50, is_dragging: false }]) });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pin + meta flow through to the posted payload", async () => {
    const initial = mkT([{ id: "a", left: 0, is_dragging: false }]);
    const { result, rerender } = renderHook(
      ({ t }) => useDiffEmitter(t, "p1", "s1", true),
      { initialProps: { t: initial } },
    );
    act(() =>
      result.current.beginCommit({
        cause: "scrubber.update",
        pin: "permanent",
        meta: { note: "keep" },
      }),
    );
    rerender({ t: mkT([{ id: "a", left: 5, is_dragging: false }]) });
    await flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.event.pin).toBe("permanent");
    expect(body.event.meta).toEqual({ note: "keep" });
  });
});
