#!/usr/bin/env bash
# Pre-commit hook: block branch-scoped forbidden patterns from staged changes.
#
# This hook enforces clean-upstream discipline for long-lived forks that
# maintain both a "contribute-upstream" branch (free of fork-owner-specific
# identifiers) and a private integration branch where those identifiers are
# allowed.
#
# Configuration:
#   - ASCII_PATTERNS: extended-regex alternation matched against added lines
#     and new filenames (case-insensitive)
#   - ARABIC_BYTE_PATTERN: detects any byte sequence in the UTF-8 Arabic range
#     U+0600..U+06FF (bytes 0xD8..0xDB followed by 0x80..0xBF); runs with
#     LC_ALL=C so the byte classes are interpreted literally
#   - PROTECTED_BRANCHES: extended-regex anchored match on branch name
#
# Install (from repo root):
#   cp scripts/pre-commit.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
# On POSIX systems a symlink is fine too:
#   ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit

set -u

ASCII_PATTERNS='[[:<:]]mufeed[[:>:]]|[[:<:]]yousef[[:>:]]|[[:<:]]palestinian[[:>:]]|[[:<:]]levantine[[:>:]]'
# POSIX word boundaries (`[[:<:]]`/`[[:>:]]`) aren't portable across every grep;
# fall back to a coarser match that still avoids the most common false positives.
if ! echo test | grep -E "$ASCII_PATTERNS" >/dev/null 2>&1; then
  ASCII_PATTERNS='(^|[^a-z0-9_])(mufeed|yousef|palestinian|levantine)([^a-z0-9_]|$)'
fi

PROTECTED_BRANCHES='^(agentic-mode|upstream-main|main)$'

# Allowlist: files where the hook itself documents the patterns. If removed,
# the hook cannot meaningfully describe what it enforces.
ALLOWLIST_PATHS='scripts/pre-commit.sh'

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if ! echo "$branch" | grep -Eq "$PROTECTED_BRANCHES"; then
  exit 0
fi

# List of staged, non-deleted files (added / modified / renamed).
staged_files="$(git diff --cached --name-only --diff-filter=ACMR)"

# Filter the allowlist out of the scan.
scanned_files=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if echo "$ALLOWLIST_PATHS" | grep -Fxq "$f"; then
    continue
  fi
  scanned_files="$scanned_files$f"$'\n'
done <<< "$staged_files"

filename_ascii_violations=""
if [ -n "$scanned_files" ]; then
  filename_ascii_violations="$(printf '%s' "$scanned_files" | grep -iE "$ASCII_PATTERNS" || true)"
fi

filename_arabic_violations=""
if [ -n "$scanned_files" ]; then
  filename_arabic_violations="$(printf '%s' "$scanned_files" | LC_ALL=C grep -E $'[\xD8-\xDB][\x80-\xBF]' || true)"
fi

# Build a diff restricted to scanned files only.
content_ascii_violations=""
content_arabic_violations=""
if [ -n "$scanned_files" ]; then
  tmp_paths="$(mktemp)"
  printf '%s' "$scanned_files" > "$tmp_paths"
  diff_output="$(xargs -d '\n' -a "$tmp_paths" git diff --cached --diff-filter=ACMR -U0 -- 2>/dev/null || true)"
  rm -f "$tmp_paths"

  # Extract only added lines (ignore diff file headers starting with '+++').
  added_lines="$(printf '%s\n' "$diff_output" | grep -E '^\+' | grep -vE '^\+\+\+ ' || true)"

  if [ -n "$added_lines" ]; then
    content_ascii_violations="$(printf '%s\n' "$added_lines" | grep -iE "$ASCII_PATTERNS" || true)"
    content_arabic_violations="$(printf '%s\n' "$added_lines" | LC_ALL=C grep -E $'[\xD8-\xDB][\x80-\xBF]' || true)"
  fi
fi

any_violation=0
for v in "$filename_ascii_violations" "$filename_arabic_violations" \
         "$content_ascii_violations" "$content_arabic_violations"; do
  if [ -n "$v" ]; then
    any_violation=1
    break
  fi
done

if [ "$any_violation" -eq 1 ]; then
  echo "---------------------------------------------------------------"
  echo "pre-commit: forbidden pattern(s) detected on protected branch '$branch'"
  echo "---------------------------------------------------------------"

  if [ -n "$filename_ascii_violations" ] || [ -n "$filename_arabic_violations" ]; then
    echo "Filename violations:"
    [ -n "$filename_ascii_violations" ]  && printf '  ASCII : %s\n'  "$filename_ascii_violations"
    [ -n "$filename_arabic_violations" ] && printf '  Arabic: %s\n' "$filename_arabic_violations"
    echo
  fi

  if [ -n "$content_ascii_violations" ]; then
    echo "Added-line violations (ASCII):"
    printf '%s\n' "$content_ascii_violations" | sed 's/^/  /'
    echo
  fi

  if [ -n "$content_arabic_violations" ]; then
    echo "Added-line violations (Arabic byte range):"
    printf '%s\n' "$content_arabic_violations" | sed 's/^/  /'
    echo
  fi

  echo "Fix options:"
  echo "  * Move private content to a branch outside: $PROTECTED_BRANCHES"
  echo "  * Load values from a config/.env file instead of hardcoding"
  echo "  * Bypass with \`git commit --no-verify\` only if you truly must"
  exit 1
fi

exit 0
