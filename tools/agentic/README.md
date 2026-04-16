# agentic-sidecar

Local, **non-distributed** helpers for the agentic editing loop.

This directory is intentionally ignored by the editor's `.gitignore` and
must never be shipped as part of the editor's AGPL-licensed distribution.
It may depend on:

- The proprietary `claude-code` CLI, invoked out-of-process via `execa`
- Any Anthropic Commercial-ToS tooling (e.g. the Agent SDK)

Everything here communicates with the editor **only** via files under
`project_data/<project-id>/` — no in-process linkage, no shared Node
module graph.

## Contents

| File | Purpose |
|---|---|
| `src/extract-preferences.ts` | One-shot: read a project's `diff-log.jsonl`, invoke `claude-code -p` with a prompt, write an updated `editing-preferences.json`. |
| `src/watch.ts` | Long-running: chokidar watch over every `project_data/*/diff-log.jsonl`; debounces, then calls `extract-preferences.ts`. |

## Prerequisites

- `claude-code` CLI installed and logged in (`npm i -g @anthropic-ai/claude-code`).
- Run `pnpm install` from within this directory.

## Why it's separate

- Linking AGPL-3.0 code against proprietary dependencies (e.g. the
  Anthropic Agent SDK, or the Claude Code CLI bundled into a Docker image)
  is incompatible with AGPL's strong-copyleft clause. Keeping this sidecar
  entirely outside the editor's dependency graph sidesteps the conflict.
- File-IPC keeps the two processes stateless with respect to each other:
  if the sidecar dies, the editor keeps running; when it comes back, it
  resumes from the last JSONL line it processed.
