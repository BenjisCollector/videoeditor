import { z } from "zod";
import { TimelineStateSchema, MediaBinItemSchema } from "./timeline.js";
import { MufeedBlockSchema } from "./mufeed.js";
import { ProvenanceBlockSchema } from "./provenance.js";

// Hybrid project.json shape.
//
// - `timeline` is Kimu's native shape and the only block Kimu's editor
//   actively reads/writes. Required.
// - `mufeed` is the domain-specific sidecar, opaque to Kimu. Optional so
//   non-agentic projects parse cleanly.
// - `provenance` carries "how was this plan generated" metadata. Optional —
//   a user-authored project may have no provenance.
// - `textBinItems` is an existing Kimu field; kept for compatibility.
// - `.passthrough()` preserves any future top-level keys (e.g., a future
//   `memory` or `telemetry` block) without breaking existing files.
export const ProjectJsonSchema = z
  .object({
    version: z.literal("1.0.0"),
    projectId: z.string().min(1),
    timeline: TimelineStateSchema,
    mufeed: MufeedBlockSchema.optional(),
    provenance: ProvenanceBlockSchema.optional(),
    textBinItems: z.array(MediaBinItemSchema).default([]),
  })
  .passthrough();
export type ProjectJson = z.infer<typeof ProjectJsonSchema>;
