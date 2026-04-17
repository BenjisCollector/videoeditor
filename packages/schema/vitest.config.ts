import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "schema",
    environment: "node",
    include: ["tests/**/*.spec.ts", "tests/**/*.test.ts"],
    globals: true,
    passWithNoTests: true,
  },
});
