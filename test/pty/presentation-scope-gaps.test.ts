import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

setDefaultTimeout(30_000);

/**
 * Reproduction + candidate evidence for #1235: a full-file presentation scope
 * must not remove the unchanged-lines (gap) rows of the scoped file, and `z`
 * plus clicking a gap row must expand them.
 */

const SCOPE_FILE_EXTENSION_SOURCE = `import type { HunkExtensionAPI } from "hunkdiff/extension";

// Scope the review to the selected file, keeping every hunk of it (#1235).
export default function (hunk: HunkExtensionAPI) {
  hunk.registerCommand({ id: "scope-file", title: "Scope to selected file", key: "f7" }, (ctx) => {
    const file = ctx.selection.file;
    const review = ctx.review.snapshot();
    if (!file || !review) {
      ctx.notify("SCOPE_MISSING_SELECTION");
      return;
    }
    const hunkCount = file.patch.split("\\n").filter((line) => line.startsWith("@@")).length;
    const applied = ctx.review.setPresentationScope({
      generation: review.generation,
      files: [{ fileId: file.id, hunkIndexes: Array.from({ length: hunkCount }, (_, i) => i) }],
    });
    ctx.notify(applied ? "SCOPE_APPLIED_OK" : "SCOPE_APPLIED_FALSE");
  });
}
`;

const FILE_BEFORE = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function fileAfter() {
  return FILE_BEFORE.replace("line 50\n", "line 50 changed\n").replace(
    "line 100\n",
    "line 100 changed\n",
  );
}

function runGit(args: string[], cwd: string) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
}

/** Repo where `a.ts`/`b.ts` change on lines 50 and 100; the extension is committed separately. */
function createScopeFixture(dir: string, extensionSource: string) {
  runGit(["init"], dir);
  runGit(["config", "user.name", "Pi"], dir);
  runGit(["config", "user.email", "pi@example.com"], dir);
  mkdirSync(join(dir, ".hunk", "extensions"), { recursive: true });
  writeFileSync(join(dir, ".hunk", "extensions", "scope-file.ts"), extensionSource);
  writeFileSync(join(dir, "a.ts"), FILE_BEFORE);
  writeFileSync(join(dir, "b.ts"), FILE_BEFORE);
  runGit(["add", "."], dir);
  runGit(["commit", "-qm", "scope extension"], dir);
  writeFileSync(join(dir, "a.ts"), fileAfter());
  writeFileSync(join(dir, "b.ts"), fileAfter());
}

for (const mode of ["unified", "split"] as const) {
  test(`full-file scope keeps gap rows and expansion (${mode})`, async () => {
    const harness = createPtyHarness();
    const fixtureDir = mkdtempSync(join(tmpdir(), "hunk-j1235-"));
    let session: Awaited<ReturnType<typeof harness.launchHunk>> | undefined;
    try {
      createScopeFixture(fixtureDir, SCOPE_FILE_EXTENSION_SOURCE);

      session = await harness.launchHunk({
        args: [
          "diff",
          "HEAD",
          "--mode",
          mode,
          "--theme",
          "github-dark-default",
          "--extension",
          join(fixtureDir, ".hunk", "extensions", "scope-file.ts"),
        ],
        cwd: fixtureDir,
        cols: 140,
        rows: 40,
      });
      await harness.ensureKeyboardIsLive(session);
      const initial = await session.waitForText(/46 unchanged lines/, { timeout: 10_000 });
      expect(initial).toContain("a.ts");

      // Let the review finish settling (source highlight and any internal
      // reload) before the extension snapshots: a command fired during that
      // refresh can see a generation or runtime id it cannot bind to.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await harness.waitForSnapshot(session, (text) => text.includes("46 unchanged lines"), 5_000);

      // Scope the review to the selected file, keeping every hunk of it. The
      // extension is single-attempt and the review has settled above, so one
      // press binds to the fresh generation and runtime id. This test does not
      // retry a rejected scope: a fixed generation cannot be reused after a
      // reload renumbers runtime ids, and re-running the whole test is the
      // honest retry (a rejection-path test would need a rejection/reload
      // fixture, out of scope here).
      const scoped = await harness.pressAndWaitForSnapshot(
        session,
        "f7",
        (text) => text.includes("SCOPE_APPLIED_OK"),
        10_000,
      );
      expect(scoped).toContain("SCOPE_APPLIED_OK");

      // A scope that keeps every hunk must not remove the unchanged-lines rows.
      expect(scoped).toContain("46 unchanged lines");
      expect(scoped).toContain("43 unchanged lines");

      // Keyboard expansion still works inside the scope.
      await session.press("z");
      const expanded = await session.waitForText(/Hide 46 unchanged lines/, { timeout: 10_000 });
      expect(expanded).toContain("Hide 46 unchanged lines");
      expect(expanded).toMatch(/line 5( |$)/m);

      // Mouse collapse-and-expand on the same gap works inside the scope.
      const collapsed = await harness.clickAndWaitForSnapshot(
        session,
        /Hide 46 unchanged lines/,
        (text) => text.includes("46 unchanged lines") && !text.includes("Hide 46 unchanged lines"),
        { timeout: 10_000 },
      );
      expect(collapsed).toContain("46 unchanged lines");

      const reclicked = await harness.clickAndWaitForSnapshot(
        session,
        /46 unchanged lines/,
        (text) => /line 5( |$)/m.test(text) && text.includes("Hide 46 unchanged lines"),
        { timeout: 10_000 },
      );
      expect(reclicked).toMatch(/line 5( |$)/m);
    } finally {
      try {
        session?.close();
      } finally {
        try {
          harness.cleanup();
        } finally {
          rmSync(fixtureDir, { recursive: true, force: true });
        }
      }
    }
  });
}
