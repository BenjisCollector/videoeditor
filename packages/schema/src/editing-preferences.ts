import { z } from "zod";

// EditingPreferences: extracted, human-curated tendencies used as
// system-prompt context by an external planner. Intentionally small —
// a 1500-token hard cap is enforced at write time (not in this schema)
// to keep the preference file from silently bloating the context.
//
// Split into `global` (stable across videos, accepted >=N times across
// multiple videos) and `provisional` (inferred from the current video
// only, expires when a new video opens). The extractor proposes; a
// human accepts — nothing lands without explicit confirmation.

export const PreferenceConfidenceSchema = z.number().min(0).max(1);

export const PreferenceProvenanceSchema = z.object({
  // Session ids the pattern was observed in.
  sessions: z.array(z.string()).default([]),
  // Project ids the pattern was observed in.
  projects: z.array(z.string()).default([]),
  // Free-form human-authored rationale for the preference.
  rationale: z.string().optional(),
});
export type PreferenceProvenance = z.infer<typeof PreferenceProvenanceSchema>;

export const PreferenceItemSchema = z.object({
  id: z.string(),
  pattern: z.string(),
  observation: z.string(),
  suggested_plan_adjustment: z.string().optional(),
  confidence: PreferenceConfidenceSchema,
  provenance: PreferenceProvenanceSchema.default({
    sessions: [],
    projects: [],
  }),
  // When absent the preference is active; set to an ISO timestamp to
  // soft-retire without deleting (e.g. user revoked it).
  revoked_at: z.string().optional(),
});
export type PreferenceItem = z.infer<typeof PreferenceItemSchema>;

export const EditingPreferencesSchema = z.object({
  v: z.literal(1),
  generated_at: z.string(), // ISO-8601
  based_on_videos: z.number().int().nonnegative().default(0),
  global: z.array(PreferenceItemSchema).default([]),
  provisional: z.array(PreferenceItemSchema).default([]),
  // Free-form notes the extractor can leave for its future self.
  meta_notes: z.string().optional(),
});
export type EditingPreferences = z.infer<typeof EditingPreferencesSchema>;
