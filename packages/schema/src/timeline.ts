import { z } from "zod";

// Timeline schema. Kept structurally compatible with the editor app's
// `app/schemas/timeline.ts` (same field names, same nullability). This
// package restates the schema here so external consumers can validate a
// `project.json` payload without importing the editor application source
// tree.
//
// If the app-side schema evolves, this mirror should be bumped in
// lockstep and a minor-version change communicated to consumers.

export const TextPropertiesSchema = z.object({
  textContent: z.string(),
  fontSize: z.number(),
  fontFamily: z.string(),
  color: z.string(),
  textAlign: z.enum(["left", "center", "right"]),
  fontWeight: z.enum(["normal", "bold"]),
  template: z.enum(["normal", "glassy"]).nullable(),
});
export type TextProperties = z.infer<typeof TextPropertiesSchema>;

export const TransitionSchema = z.object({
  id: z.string(),
  presentation: z.enum(["fade", "wipe", "clockWipe", "slide", "flip", "iris"]),
  timing: z.enum(["spring", "linear"]),
  durationInFrames: z.number().int().nonnegative(),
  leftScrubberId: z.string().nullable(),
  rightScrubberId: z.string().nullable(),
});
export type Transition = z.infer<typeof TransitionSchema>;

export const MediaBinBaseSchema = z.object({
  id: z.string(),
  mediaType: z.enum(["video", "image", "audio", "text", "groupped_scrubber"]),
  mediaUrlLocal: z.string().nullable(),
  mediaUrlRemote: z.string().nullable(),
  media_width: z.number(),
  media_height: z.number(),
  text: TextPropertiesSchema.nullable(),
  groupped_scrubbers: z.any().nullable(),
  left_transition_id: z.string().nullable(),
  right_transition_id: z.string().nullable(),
});

export const MediaBinItemSchema = MediaBinBaseSchema.extend({
  name: z.string(),
  durationInSeconds: z.number().nonnegative(),
  uploadProgress: z.number().nullable(),
  isUploading: z.boolean(),
});
export type MediaBinItem = z.infer<typeof MediaBinItemSchema>;

export const ScrubberStateSchema = MediaBinItemSchema.extend({
  left: z.number().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().nonnegative(),
  sourceMediaBinId: z.string(),
  left_player: z.number(),
  top_player: z.number(),
  width_player: z.number(),
  height_player: z.number(),
  is_dragging: z.boolean(),
  trimBefore: z.number().int().nullable(),
  trimAfter: z.number().int().nullable(),
});
export type ScrubberState = z.infer<typeof ScrubberStateSchema>;

export const TrackStateSchema = z.object({
  id: z.string(),
  scrubbers: z.array(ScrubberStateSchema),
  transitions: z.array(TransitionSchema),
});
export type TrackState = z.infer<typeof TrackStateSchema>;

export const TimelineStateSchema = z.object({
  tracks: z.array(TrackStateSchema),
});
export type TimelineState = z.infer<typeof TimelineStateSchema>;
