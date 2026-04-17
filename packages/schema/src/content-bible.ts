import { z } from "zod";
import type { ProjectJson } from "./project-json.js";

// SCHEMA-03 — Content-Bible validator.
//
// Keeps the validator GENERIC: the bible data (allowed codes, scene-type
// ordering rules, etc.) is passed as a parameter. This lets the module live
// on `agentic-mode` (PR-bound, no domain strings) while the actual bible
// payload lives on the integration branch as a data file.

export const ContentBibleSchema = z.object({
  formats: z.array(z.string().min(1)).nonempty(),
  angles: z.array(z.string().min(1)).nonempty(),
  structures: z.array(z.string().min(1)).nonempty(),
  seeds: z.array(z.string().min(1)).nonempty(),
  tones: z.array(z.string().min(1)).nonempty(),
  subNiches: z.array(z.string().min(1)).nonempty(),
  sceneTypePattern: z
    .object({
      // e.g. ["A","B","A","B","A","C","A","B","A"]
      expected: z.array(z.enum(["A", "B", "C"])).nonempty(),
      // max consecutive seconds of the same scene type before a rule violation
      maxSameTypeRunSec: z.number().positive(),
    })
    .optional(),
});
export type ContentBible = z.infer<typeof ContentBibleSchema>;

export interface ValidateResult {
  ok: boolean;
  issues: string[];
}

/**
 * validateAgainstBible — hard-gate validator used before writing a new plan.
 *
 * Checks the project's `mufeed` sidecar taxonomy + scene sequence against the
 * provided bible. Projects with no `mufeed` block pass vacuously (bible rules
 * only apply to bible-governed projects).
 */
export function validateAgainstBible(
  project: ProjectJson,
  bible: ContentBible,
): ValidateResult {
  const issues: string[] = [];
  const m = project.mufeed;
  if (!m) return { ok: true, issues };

  // Taxonomy membership
  const t = m.taxonomy;
  if (!bible.formats.includes(t.format)) {
    issues.push(`format "${t.format}" not in bible.formats`);
  }
  if (!bible.angles.includes(t.angle)) {
    issues.push(`angle "${t.angle}" not in bible.angles`);
  }
  if (!bible.structures.includes(t.structure)) {
    issues.push(`structure "${t.structure}" not in bible.structures`);
  }
  if (!bible.seeds.includes(t.seed)) {
    issues.push(`seed "${t.seed}" not in bible.seeds`);
  }
  if (!bible.tones.includes(t.tone)) {
    issues.push(`tone "${t.tone}" not in bible.tones`);
  }
  if (!bible.subNiches.includes(t.subNiche)) {
    issues.push(`subNiche "${t.subNiche}" not in bible.subNiches`);
  }

  // Scene-type run length
  if (bible.sceneTypePattern && m.scenes.length > 0) {
    const { maxSameTypeRunSec } = bible.sceneTypePattern;
    let runType = m.scenes[0].type;
    let runLenSec = m.scenes[0].durationSec;
    for (let i = 1; i < m.scenes.length; i++) {
      const s = m.scenes[i];
      if (s.type === runType) {
        runLenSec += s.durationSec;
        if (runLenSec > maxSameTypeRunSec) {
          issues.push(
            `scene-type "${runType}" held for ${runLenSec.toFixed(1)}s (> ${maxSameTypeRunSec}s cap) at scene ${i}`,
          );
        }
      } else {
        runType = s.type;
        runLenSec = s.durationSec;
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

// Alias per REQ-ID naming in PLAN-01.
export const validateMufeedTaxonomy = validateAgainstBible;
