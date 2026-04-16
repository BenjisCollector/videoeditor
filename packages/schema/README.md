# @videoeditor/schema

Shared Zod schemas and TypeScript types for artifacts that cross process
boundaries in the editor workspace:

- `TimelineState` — the on-disk shape of a saved project's timeline
- `DiffEvent` — one append-only entry in `diff-log.jsonl`, emitted when the
  editor's undo stack commits a new snapshot
- `EditingPreferences` — extracted tendencies consumed as system-prompt
  context by an external planner

This package is intentionally self-contained — it has no runtime
dependencies beyond `zod`, no React, no file I/O. It only defines the wire
shapes.

## Usage

```ts
import {
  TimelineStateSchema,
  DiffEventSchema,
  EditingPreferencesSchema,
} from '@videoeditor/schema';

const timeline = TimelineStateSchema.parse(rawJson);
```

## Stability

The schemas carry an explicit `version` / `v` field. Consumers should
reject payloads whose version they do not understand, rather than falling
back silently.
