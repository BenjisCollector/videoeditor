import { z } from "zod";

// ProvenanceBlock: deterministic-friendly metadata that survives round-trip
// save/load and is consumed by downstream tooling (extractor reads
// preferenceVersionUsed to correlate pattern learning with plan input).
export const ProvenanceBlockSchema = z
  .object({
    generatedBy: z.string().min(1),
    generatedAt: z.string().min(1), // ISO-8601 recommended; string for flexibility
    pipelineInputHash: z.string().optional(),
    preferenceVersionUsed: z.string().optional(),
    inputHashForDeterminism: z.string().optional(),
  })
  .passthrough();
export type ProvenanceBlock = z.infer<typeof ProvenanceBlockSchema>;
