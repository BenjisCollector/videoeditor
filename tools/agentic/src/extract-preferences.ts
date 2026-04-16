/**
 * extract-preferences.ts
 *
 * One-shot: for a given project id, read the project's diff-log.jsonl,
 * summarize recent events into a compact prompt, invoke the `claude-code`
 * CLI headless, and hand the user a proposed update to
 * `editing-preferences.json`.
 *
 * This tool INTENTIONALLY never writes editing-preferences.json directly —
 * it writes a proposal file `editing-preferences.proposed.json` which the
 * user explicitly accepts, rejects, or edits before promotion. The
 * confirm-step is the highest-leverage mitigation against noise-driven
 * preference drift.
 *
 * Usage:
 *   tsx src/extract-preferences.ts <project-id> [--project-data-root <path>]
 *
 * Environment:
 *   CLAUDE_CODE_CMD   default: "claude"
 *                     the binary name for the claude-code CLI
 *   PROJECT_DATA_ROOT default: "../../project_data" (relative to cwd)
 *
 * Exit codes:
 *   0 — proposal written (or no events to learn from; a no-op run)
 *   1 — I/O error (missing project dir, unreadable JSONL, etc.)
 *   2 — claude-code invocation failed
 */

import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

interface CliArgs {
  projectId: string;
  projectDataRoot: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.length === 0) {
    console.error(
      "usage: extract-preferences.ts <project-id> [--project-data-root <path>]",
    );
    process.exit(2);
  }

  const projectId = args[0]!;
  let projectDataRoot =
    process.env.PROJECT_DATA_ROOT ?? path.resolve(process.cwd(), "project_data");

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--project-data-root") {
      const v = args[++i];
      if (!v) {
        console.error("--project-data-root requires a value");
        process.exit(2);
      }
      projectDataRoot = path.resolve(v);
    }
  }

  return { projectId, projectDataRoot };
}

async function readJsonlLines(filePath: string): Promise<unknown[]> {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const parsed: unknown[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // Silently drop malformed tail lines; JSONL append-atomicity guarantees
      // only the final line of a crashed write is ever mis-formed.
    }
  }
  return parsed;
}

interface ClaudeInvocation {
  prompt: string;
  cmd: string;
  args: string[];
}

function buildInvocation(opts: {
  events: unknown[];
  existingPreferences: string | null;
  projectId: string;
}): ClaudeInvocation {
  const cmd = process.env.CLAUDE_CODE_CMD ?? "claude";
  const promptHeader =
    `You are proposing an update to a single editor's editing-preferences.json ` +
    `based on the diff-log events for project "${opts.projectId}". ` +
    `Return a strict JSON object validating @videoeditor/schema's ` +
    `EditingPreferencesSchema. Keep the file under ~1500 tokens. ` +
    `Never invent tendencies unsupported by the events. If the events are ` +
    `insufficient, return the existing preferences unchanged (or an empty ` +
    `skeleton if none exist).`;

  const eventSummary = JSON.stringify(opts.events.slice(-200));
  const existing = opts.existingPreferences ?? "(none)";

  const prompt = [
    promptHeader,
    "",
    "## Existing preferences (if any)",
    existing,
    "",
    "## Latest diff-log events (up to 200, newest last)",
    eventSummary,
    "",
    "## Output format",
    "Return ONLY a single JSON object (no markdown fences, no commentary).",
  ].join("\n");

  // `-p` is the claude-code headless/print mode; `--output-format stream-json`
  // could be used if we wanted to stream, but a one-shot JSON response is
  // simpler to pipe here.
  const args = ["-p", "--output-format", "text"];

  return { prompt, cmd, args };
}

async function main() {
  const { projectId, projectDataRoot } = parseArgs(process.argv);

  const projectDir = path.join(projectDataRoot, projectId);
  const diffLogPath = path.join(projectDir, "diff-log.jsonl");
  const prefsPath = path.join(projectDir, "editing-preferences.json");
  const proposedPath = path.join(projectDir, "editing-preferences.proposed.json");

  try {
    await fs.access(projectDir);
  } catch {
    console.error(`[extract] project dir not found: ${projectDir}`);
    process.exit(1);
  }

  const events = await readJsonlLines(diffLogPath);
  if (events.length === 0) {
    console.log(
      `[extract] no events in ${diffLogPath}; nothing to propose`,
    );
    return;
  }

  let existingPreferences: string | null = null;
  try {
    existingPreferences = await fs.readFile(prefsPath, "utf8");
  } catch {
    // No existing preferences file; that's fine for a first run.
  }

  const { prompt, cmd, args } = buildInvocation({
    events,
    existingPreferences,
    projectId,
  });

  let stdout = "";
  try {
    const result = await execa(cmd, args, {
      input: prompt,
      reject: true,
      timeout: 120_000,
    });
    stdout = result.stdout;
  } catch (err) {
    console.error(
      `[extract] claude-code invocation failed:`,
      (err as Error).message,
    );
    process.exit(2);
  }

  // Best-effort JSON extraction. If claude-code wraps the output in
  // markdown, trim fences.
  let jsonCandidate = stdout.trim();
  const fenceMatch = jsonCandidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    jsonCandidate = fenceMatch[1].trim();
  }

  try {
    JSON.parse(jsonCandidate);
  } catch (err) {
    console.error(
      `[extract] model output did not parse as JSON; wrote raw output to .raw for triage`,
    );
    await fs.writeFile(`${proposedPath}.raw`, stdout, "utf8");
    process.exit(2);
  }

  await fs.writeFile(proposedPath, jsonCandidate, "utf8");
  console.log(`[extract] wrote proposal: ${proposedPath}`);
  console.log(
    `[extract] review, edit, and rename to editing-preferences.json to apply`,
  );
}

main().catch((err) => {
  console.error("[extract] unexpected error:", err);
  process.exit(1);
});
