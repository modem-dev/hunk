import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // Not `*.test.ts` or `*.spec.ts`, so `bun test` never collects these Playwright-runner files.
  testMatch: "**/*.e2e.ts",
  outputDir: join(tmpdir(), "hunk-web-test-results"),
  // Each test owns a private daemon port, but one browser and one daemon at a time keeps the
  // suite predictable on small CI runners.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    trace: "off",
  },
});
