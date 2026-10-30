import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
setDefaultTimeout(20_000);

afterEach(() => harness.cleanup());

test("same-directory rename headers keep both filenames visible without repeating the directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunk-rename-header-"));
  const patchFile = join(dir, "rename.patch");
  const previousPath = "packages/hunk/src/ui/fileViews/textDisplay.ts";
  const path = "packages/hunk/src/ui/fileViews/textPreview.ts";
  writeFileSync(
    patchFile,
    [
      `diff --git a/${previousPath} b/${path}`,
      "similarity index 90%",
      `rename from ${previousPath}`,
      `rename to ${path}`,
      `--- a/${previousPath}`,
      `+++ b/${path}`,
      "@@ -1,2 +1,2 @@",
      " export const stable = true;",
      "-export const answer = 41;",
      "+export const answer = 42;",
      "",
    ].join("\n"),
  );

  try {
    const session = await harness.launchHunk({
      args: ["patch", patchFile, "--no-sidebar", "--mode", "unified"],
      cols: 80,
      rows: 20,
    });
    try {
      const frame = await session.waitForText(/textDisplay\.ts -> textPreview\.ts/, {
        timeout: 15_000,
      });
      expect(frame).toContain(`${previousPath} -> textPreview.ts`);
      expect(frame).toContain("+1 -1");
      expect(frame).not.toContain(`${previousPath} -> ${path}`);
    } finally {
      session.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
