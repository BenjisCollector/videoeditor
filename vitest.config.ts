import { defineConfig } from "vitest/config";
import fs from "node:fs";
import path from "node:path";

const maybeAgentic = path.resolve("./tools/agentic/vitest.config.ts");
const agenticProject = fs.existsSync(maybeAgentic)
  ? [maybeAgentic]
  : [];

export default defineConfig({
  test: {
    // Dynamic project list: schema always; tools/agentic only when present
    // (the directory is gitignored on PR-bound branches, tracked on the
    // integration branch where the sidecar lives).
    projects: [
      "./packages/schema/vitest.config.ts",
      ...agenticProject,
      // app-level project configs added in Wave 2/4 when hook/component tests land
    ],
  },
});
