import { describe, it, expect } from "vitest";
import {
  ProjectJsonSchema,
  canonicalize,
  deterministicClipUuid,
  CLIP_NAMESPACE,
  validateAgainstBible,
  ContentBibleSchema,
  type ProjectJson,
  type ContentBible,
} from "../src/index.js";

const MINIMAL: unknown = {
  version: "1.0.0",
  projectId: "p-1",
  timeline: { tracks: [] },
  textBinItems: [],
};

const WITH_SIDECAR: unknown = {
  ...(MINIMAL as object),
  mufeed: {
    taxonomy: {
      format: "FORMAT_A",
      angle: "ANGLE_1",
      structure: "STRUCT_1",
      seed: "SEED_1",
      tone: "TONE_1",
      subNiche: "NICHE_1",
    },
    title: "test plan",
    scenes: [],
  },
  provenance: {
    generatedBy: "claude-code@2.1.0",
    generatedAt: "2026-04-17T00:00:00Z",
  },
};

// ---------------------------------------------------------------------------
// SCHEMA-01 — hybrid ProjectJson shape
// ---------------------------------------------------------------------------

describe("SCHEMA-01 hybrid ProjectJson", () => {
  it("accepts minimal timeline-only project", () => {
    const parsed = ProjectJsonSchema.safeParse(MINIMAL);
    expect(parsed.success).toBe(true);
  });

  it("accepts project with mufeed + provenance sidecars", () => {
    const parsed = ProjectJsonSchema.safeParse(WITH_SIDECAR);
    expect(parsed.success).toBe(true);
  });

  it("rejects version other than 1.0.0", () => {
    const bad = { ...(MINIMAL as object), version: "2.0.0" };
    expect(ProjectJsonSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects missing projectId", () => {
    const bad = { ...(MINIMAL as object), projectId: "" };
    expect(ProjectJsonSchema.safeParse(bad).success).toBe(false);
  });

  it("preserves unknown top-level keys via passthrough", () => {
    const withUnknown = {
      ...(MINIMAL as object),
      futureBlock: { foo: "bar" },
    };
    const parsed = ProjectJsonSchema.parse(withUnknown);
    expect((parsed as unknown as { futureBlock: unknown }).futureBlock).toEqual({
      foo: "bar",
    });
  });

  it("rejects mufeed.taxonomy with empty fields", () => {
    const bad = {
      ...(WITH_SIDECAR as object),
      mufeed: {
        taxonomy: {
          format: "",
          angle: "A",
          structure: "S",
          seed: "X",
          tone: "T",
          subNiche: "N",
        },
        title: "x",
        scenes: [],
      },
    };
    expect(ProjectJsonSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts provenance with optional fields only", () => {
    const parsed = ProjectJsonSchema.safeParse({
      ...(MINIMAL as object),
      provenance: {
        generatedBy: "x",
        generatedAt: "y",
        preferenceVersionUsed: "v1",
      },
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SCHEMA-02 — round-trip preserves unknown keys (simulates store read-merge-write)
// ---------------------------------------------------------------------------

describe("SCHEMA-02 round-trip", () => {
  it("parse → stringify → parse preserves mufeed + provenance", () => {
    const first = ProjectJsonSchema.parse(WITH_SIDECAR);
    const serialized = JSON.stringify(first);
    const second = ProjectJsonSchema.parse(JSON.parse(serialized));
    expect(second.mufeed).toEqual(first.mufeed);
    expect(second.provenance).toEqual(first.provenance);
  });

  it("5 save/load cycles remain byte-identical under canonicalize", () => {
    let current: ProjectJson = ProjectJsonSchema.parse(WITH_SIDECAR);
    const baseline = canonicalize(current);
    for (let i = 0; i < 5; i++) {
      current = ProjectJsonSchema.parse(JSON.parse(JSON.stringify(current)));
      expect(canonicalize(current)).toBe(baseline);
    }
  });

  it("unknown keys survive stringify/parse via passthrough", () => {
    const withUnknown = {
      ...(MINIMAL as object),
      memoryBlock: { note: "hello" },
    };
    const parsed = ProjectJsonSchema.parse(withUnknown);
    const serialized = JSON.stringify(parsed);
    const reparsed = ProjectJsonSchema.parse(JSON.parse(serialized));
    expect(
      (reparsed as unknown as { memoryBlock: unknown }).memoryBlock,
    ).toEqual({ note: "hello" });
  });

  it("stays valid against ProjectJsonSchema post-save", () => {
    const parsed = ProjectJsonSchema.parse(WITH_SIDECAR);
    const roundTripped = ProjectJsonSchema.safeParse(
      JSON.parse(JSON.stringify(parsed)),
    );
    expect(roundTripped.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SCHEMA-03 — content-bible validator (parameter-driven, generic)
// ---------------------------------------------------------------------------

describe("SCHEMA-03 Content-Bible validator", () => {
  const bible: ContentBible = {
    formats: ["FORMAT_A", "FORMAT_B"],
    angles: ["ANGLE_1"],
    structures: ["STRUCT_1"],
    seeds: ["SEED_1"],
    tones: ["TONE_1"],
    subNiches: ["NICHE_1"],
    sceneTypePattern: {
      expected: ["A", "B", "A"],
      maxSameTypeRunSec: 3.0,
    },
  };

  it("ContentBibleSchema itself parses", () => {
    expect(ContentBibleSchema.safeParse(bible).success).toBe(true);
  });

  it("project without mufeed passes vacuously", () => {
    const parsed = ProjectJsonSchema.parse(MINIMAL);
    const res = validateAgainstBible(parsed, bible);
    expect(res.ok).toBe(true);
    expect(res.issues).toHaveLength(0);
  });

  it("accepts project with taxonomy codes present in bible", () => {
    const parsed = ProjectJsonSchema.parse(WITH_SIDECAR);
    const res = validateAgainstBible(parsed, bible);
    expect(res.ok).toBe(true);
  });

  it("rejects taxonomy code missing from bible", () => {
    const parsed = ProjectJsonSchema.parse({
      ...(WITH_SIDECAR as object),
      mufeed: {
        ...((WITH_SIDECAR as { mufeed: object }).mufeed as object),
        taxonomy: {
          format: "UNKNOWN_FORMAT",
          angle: "ANGLE_1",
          structure: "STRUCT_1",
          seed: "SEED_1",
          tone: "TONE_1",
          subNiche: "NICHE_1",
        },
      },
    });
    const res = validateAgainstBible(parsed, bible);
    expect(res.ok).toBe(false);
    expect(res.issues.join(" ")).toContain("UNKNOWN_FORMAT");
  });

  it("flags scene-type run exceeding maxSameTypeRunSec", () => {
    const parsed = ProjectJsonSchema.parse({
      ...(WITH_SIDECAR as object),
      mufeed: {
        taxonomy: {
          format: "FORMAT_A",
          angle: "ANGLE_1",
          structure: "STRUCT_1",
          seed: "SEED_1",
          tone: "TONE_1",
          subNiche: "NICHE_1",
        },
        title: "x",
        scenes: [
          {
            id: "s1",
            type: "A",
            durationSec: 2,
            spoken: "",
            subtitle: "",
            media: null,
            clipRefs: [],
          },
          {
            id: "s2",
            type: "A",
            durationSec: 2,
            spoken: "",
            subtitle: "",
            media: null,
            clipRefs: [],
          },
        ],
      },
    });
    const res = validateAgainstBible(parsed, bible);
    expect(res.ok).toBe(false);
    expect(res.issues.join(" ")).toMatch(/scene-type "A" held for 4/);
  });

  it("passes when scene types alternate within cap", () => {
    const parsed = ProjectJsonSchema.parse({
      ...(WITH_SIDECAR as object),
      mufeed: {
        taxonomy: {
          format: "FORMAT_A",
          angle: "ANGLE_1",
          structure: "STRUCT_1",
          seed: "SEED_1",
          tone: "TONE_1",
          subNiche: "NICHE_1",
        },
        title: "x",
        scenes: [
          {
            id: "s1",
            type: "A",
            durationSec: 2,
            spoken: "",
            subtitle: "",
            media: null,
            clipRefs: [],
          },
          {
            id: "s2",
            type: "B",
            durationSec: 2,
            spoken: "",
            subtitle: "",
            media: null,
            clipRefs: [],
          },
        ],
      },
    });
    const res = validateAgainstBible(parsed, bible);
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SCHEMA-04 — canonical-JSON + deterministic UUID v5
// ---------------------------------------------------------------------------

describe("SCHEMA-04 canonicalize + deterministicClipUuid", () => {
  it("sorts object keys alphabetically", () => {
    const a = { b: 1, a: 2, c: 3 };
    expect(canonicalize(a)).toBe('{"a":2,"b":1,"c":3}');
  });

  it("rounds floats to 3 decimals", () => {
    expect(canonicalize({ x: 1.234567 })).toBe('{"x":1.235}');
    expect(canonicalize({ x: 0.0001 })).toBe('{"x":0}');
  });

  it("leaves integers exact", () => {
    expect(canonicalize({ n: 42 })).toBe('{"n":42}');
  });

  it("is stable across repeat calls", () => {
    const obj = { b: [3.14159, 2.71828], a: { y: 1, x: 2 } };
    expect(canonicalize(obj)).toBe(canonicalize(obj));
  });

  it("rejects NaN", () => {
    expect(() => canonicalize({ x: NaN })).toThrow();
  });

  it("drops undefined values", () => {
    const obj: Record<string, unknown> = { a: 1, b: undefined };
    expect(canonicalize(obj)).toBe('{"a":1}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("deterministicClipUuid is stable for same (namespace, key)", () => {
    const id1 = deterministicClipUuid(CLIP_NAMESPACE, "scene-1");
    const id2 = deterministicClipUuid(CLIP_NAMESPACE, "scene-1");
    expect(id1).toBe(id2);
  });

  it("deterministicClipUuid differs for different keys", () => {
    const id1 = deterministicClipUuid(CLIP_NAMESPACE, "scene-1");
    const id2 = deterministicClipUuid(CLIP_NAMESPACE, "scene-2");
    expect(id1).not.toBe(id2);
  });

  it("deterministicClipUuid returns a valid UUID v5 shape", () => {
    const id = deterministicClipUuid(CLIP_NAMESPACE, "x");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
