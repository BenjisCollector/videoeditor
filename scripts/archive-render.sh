#!/usr/bin/env bash
# archive-render.sh — snapshot per-project state at render time.
#
# Captures an immutable record of "what produced this render" so that
# downstream analysis (preference drift, regression debugging, A/B
# reviews) can always replay the exact inputs:
#
#   - project_data/<project-id>/*.json           (scene plan, preferences, etc.)
#   - current git SHA + short dirty-flag for the repo
#   - the render's output path (if supplied)
#
# Usage:
#   scripts/archive-render.sh <project-id> [render-output-path]
#
# Output layout (relative to ARCHIVE_ROOT):
#   archive/<iso-timestamp>__<project-id>/
#     project.json               (copied if present)
#     editing-preferences.json   (copied if present)
#     diff-log.jsonl             (copied if present)
#     other-*.json               (everything else under project_data/<id>)
#     git-info.txt               (SHA, branch, porcelain status summary)
#     render-output.txt          (path echoed back)
#
# Environment overrides:
#   PROJECT_DATA_ROOT   default: ./project_data
#   ARCHIVE_ROOT        default: ./archive
#
# The script is intentionally side-effect-minimal: never mutates the
# source project_data, never calls git write commands, exits non-zero on
# any missing required input.

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <project-id> [render-output-path]" >&2
  exit 2
fi

project_id="$1"
render_output="${2:-}"

# Basic input sanitation — prevent path traversal on the id.
case "$project_id" in
  */* | .. | . | *..*)
    echo "archive-render: refusing suspicious project id '$project_id'" >&2
    exit 2
    ;;
esac

PROJECT_DATA_ROOT="${PROJECT_DATA_ROOT:-./project_data}"
ARCHIVE_ROOT="${ARCHIVE_ROOT:-./archive}"

src_dir="$PROJECT_DATA_ROOT/$project_id"
if [ ! -d "$src_dir" ]; then
  echo "archive-render: source not found: $src_dir" >&2
  exit 1
fi

# UTC, filesystem-safe timestamp (no colons).
timestamp="$(date -u +'%Y-%m-%dT%H-%M-%SZ')"
dest_dir="$ARCHIVE_ROOT/${timestamp}__${project_id}"

mkdir -p "$dest_dir"

copy_if_exists() {
  local relpath="$1"
  local src="$src_dir/$relpath"
  if [ -f "$src" ]; then
    cp -p "$src" "$dest_dir/$(basename "$relpath")"
  fi
}

# Priority snapshots — these are the loop's load-bearing files.
copy_if_exists "project.json"
copy_if_exists "editing-preferences.json"
copy_if_exists "diff-log.jsonl"

# Bulk-copy any remaining top-level JSON files not already snapshotted.
for f in "$src_dir"/*.json; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  case "$base" in
    project.json|editing-preferences.json) continue ;;
  esac
  cp -p "$f" "$dest_dir/$base"
done

# Capture git provenance.
{
  echo "# git provenance"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    sha="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
    branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
    dirty="clean"
    if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
      dirty="dirty"
    fi
    echo "sha: $sha"
    echo "branch: $branch"
    echo "working-tree: $dirty"
  else
    echo "(not inside a git work tree)"
  fi
  echo
  echo "# archived at (utc)"
  echo "$timestamp"
  echo
  echo "# hostname"
  hostname 2>/dev/null || echo "unknown"
} > "$dest_dir/git-info.txt"

# Render output pointer (optional — just echoed, not copied).
if [ -n "$render_output" ]; then
  {
    echo "# render output path (as supplied)"
    echo "$render_output"
  } > "$dest_dir/render-output.txt"
fi

echo "$dest_dir"
