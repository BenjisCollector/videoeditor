import { z } from "zod";

// Taxonomy shape — actual enumerated codes live in bible config on `mufeed` branch.
// This file is generic: it describes WHAT fields a domain-sidecar carries, not
// WHICH values are allowed. Per-value validation lives in content-bible.ts where
// the bible is passed as a parameter.
export const TaxonomySchema = z.object({
  format: z.string().min(1),
  angle: z.string().min(1),
  structure: z.string().min(1),
  seed: z.string().min(1),
  tone: z.string().min(1),
  subNiche: z.string().min(1),
});
export type Taxonomy = z.infer<typeof TaxonomySchema>;

export const MufeedSceneSchema = z.object({
  id: z.string(),
  type: z.enum(["A", "B", "C"]),
  durationSec: z.number().nonnegative(),
  spoken: z.string(),
  subtitle: z.string(),
  media: z.unknown().nullable(),
  clipRefs: z.array(z.string()).default([]),
});
export type MufeedScene = z.infer<typeof MufeedSceneSchema>;

export const MufeedBlockSchema = z
  .object({
    taxonomy: TaxonomySchema,
    title: z.string(),
    scenes: z.array(MufeedSceneSchema).default([]),
  })
  .passthrough();
export type MufeedBlock = z.infer<typeof MufeedBlockSchema>;
