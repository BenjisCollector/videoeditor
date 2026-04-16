import { z } from "zod";

// DiffEvent: one append-only entry in `project_data/<id>/diff-log.jsonl`,
// emitted by the editor each time the undo stack commits a snapshot.
//
// Design notes:
//   - Patches are RFC 6902 JSON Patch; the `inverse_patches` array lets
//     consumers replay and undo without requiring the full before/after
//     snapshots. When `omit_patches` is true (size-constrained sessions)
//     the array may be empty and consumers should fall back to the
//     `before_hash`/`after_hash` pair for integrity checks.
//   - `cause` is a free-form tag attached at the snapshot call site
//     (trim, move, delete, ...). Unknown causes are allowed so the
//     editor can ship new instrumentation without schema breakage.
//   - `scrubber_ids` is a derived convenience field — callers may recompute
//     it from `patches` if needed.

export const RFC6902_OPS = [
  "add",
  "remove",
  "replace",
  "move",
  "copy",
  "test",
] as const;

export const JsonPatchOperationSchema = z.object({
  op: z.enum(RFC6902_OPS),
  path: z.string(),
  from: z.string().optional(),
  value: z.unknown().optional(),
});
export type JsonPatchOperation = z.infer<typeof JsonPatchOperationSchema>;

export const DiffEventSchema = z.object({
  v: z.literal(1),
  ts: z.string(), // ISO-8601
  project_id: z.string(),
  session_id: z.string(),
  cause: z.string(),
  scrubber_ids: z.array(z.string()).default([]),
  patches: z.array(JsonPatchOperationSchema).default([]),
  inverse_patches: z.array(JsonPatchOperationSchema).default([]),
  before_hash: z.string().optional(),
  after_hash: z.string().optional(),
  // Pin/one-off flags set by the UI at edit time. Consumed by the
  // preference extractor (one-off edits are excluded from learning;
  // pinned edits are weighted up).
  pin: z.enum(["permanent", "one-off"]).optional(),
  // Arbitrary pass-through metadata consumers may attach.
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type DiffEvent = z.infer<typeof DiffEventSchema>;
