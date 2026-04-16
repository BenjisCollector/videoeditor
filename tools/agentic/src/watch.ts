/**
 * watch.ts
 *
 * Long-running watcher that tails every `project_data/<id>/diff-log.jsonl`
 * and debounces a call to extract-preferences.ts per project on new
 * appends.
 *
 * The watcher never writes to editing-preferences.json directly — it only
 * invokes the extractor, which writes a proposal file for the operator to
 * review. That confirm-step is the project's core safeguard against
 * noise-driven preference drift.
 *
 * Usage:
 *   tsx src/watch.ts [--project-data-root <path>] [--debounce <ms>]
 *
 * Environment:
 *   PROJECT_DATA_ROOT  default: "./project_data" relative to cwd
 *   EXTRACTOR_DEBOUNCE_MS default: 5000
 */

import chokidar from "chokidar";
import { execa } from "execa";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

interface CliArgs {
  projectDataRoot: string;
  debounceMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  let projectDataRoot =
    process.env.PROJECT_DATA_ROOT ?? path.resolve(process.cwd(), "project_data");
  let debounceMs = Number.parseInt(
    process.env.EXTRACTOR_DEBOUNCE_MS ?? "5000",
    10,
  );
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--project-data-root") {
      const v = args[++i];
      if (!v) {
        console.error("--project-data-root requires a value");
        process.exit(2);
      }
      projectDataRoot = path.resolve(v);
    } else if (a === "--debounce") {
      const v = args[++i];
      if (!v) {
        console.error("--debounce requires a value (milliseconds)");
        process.exit(2);
      }
      debounceMs = Number.parseInt(v, 10);
    }
  }
  return { projectDataRoot, debounceMs };
}

const timers = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<string>();

function scheduleExtractor(
  projectId: string,
  projectDataRoot: string,
  debounceMs: number,
) {
  const existing = timers.get(projectId);
  if (existing) clearTimeout(existing);

  const handle = setTimeout(async () => {
    timers.delete(projectId);
    if (inFlight.has(projectId)) {
      // Re-arm for after the current run completes.
      scheduleExtractor(projectId, projectDataRoot, debounceMs);
      return;
    }
    inFlight.add(projectId);
    try {
      const extractorScript = fileURLToPath(
        new URL("./extract-preferences.ts", import.meta.url),
      );
      console.log(`[watch] invoking extractor for project ${projectId}`);
      await execa(
        "tsx",
        [
          extractorScript,
          projectId,
          "--project-data-root",
          projectDataRoot,
        ],
        { reject: false, stdio: "inherit" },
      );
    } finally {
      inFlight.delete(projectId);
    }
  }, debounceMs);

  timers.set(projectId, handle);
}

function projectIdFromDiffLogPath(
  diffLogPath: string,
  projectDataRoot: string,
): string | null {
  const rel = path.relative(projectDataRoot, diffLogPath);
  if (!rel || rel.startsWith("..")) return null;
  const parts = rel.split(path.sep);
  if (parts.length < 2) return null;
  if (parts[parts.length - 1] !== "diff-log.jsonl") return null;
  return parts[0] ?? null;
}

async function main() {
  const { projectDataRoot, debounceMs } = parseArgs(process.argv);

  console.log(
    `[watch] watching ${projectDataRoot}/*/diff-log.jsonl (debounce ${debounceMs}ms)`,
  );

  const watcher = chokidar.watch(
    // chokidar accepts glob-style patterns only when `awaitWriteFinish` isn't
    // required. We use a two-segment glob to target diff-log.jsonl in any
    // immediate sub-directory of project_data.
    path.join(projectDataRoot, "*", "diff-log.jsonl"),
    {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    },
  );

  watcher.on("all", (event, changedPath) => {
    if (event !== "add" && event !== "change") return;
    const projectId = projectIdFromDiffLogPath(changedPath, projectDataRoot);
    if (!projectId) return;
    console.log(`[watch] ${event} ${changedPath}`);
    scheduleExtractor(projectId, projectDataRoot, debounceMs);
  });

  watcher.on("error", (err) => {
    console.error("[watch] watcher error:", err);
  });

  // Keep process alive; surface SIGINT cleanly.
  process.on("SIGINT", async () => {
    console.log("[watch] shutting down");
    await watcher.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[watch] unexpected error:", err);
  process.exit(1);
});
