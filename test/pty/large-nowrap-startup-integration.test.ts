import { expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

setDefaultTimeout(25_000);

/** Build an added TypeScript file with distinct first/last source markers. */
function sourceLines(count: number) {
  return (
    [
      "export const BIGFILE_FIRST_MARKER = 0;",
      ...Array.from({ length: count - 2 }, (_, index) => {
        const value = index + 1;
        return `export const value_${String(value).padStart(6, "0")}: number = ${value};`;
      }),
      `export const BIGFILE_LAST_MARKER = ${count - 1};`,
    ].join("\n") + "\n"
  );
}

for (const mode of ["unified", "split"] as const) {
  for (const scenario of [
    { lines: 100, wrap: false, guarded: false },
    { lines: 20_000, wrap: false, guarded: false },
    { lines: 20_000, wrap: true, guarded: false },
    { lines: 50_000, wrap: false, guarded: true },
  ]) {
    test(`staged ${scenario.lines}-line ${mode} diff: wrap=${scenario.wrap}, guarded=${scenario.guarded}`, async () => {
      const harness = createPtyHarness();
      let session: Awaited<ReturnType<typeof harness.launchHunk>> | undefined;
      try {
        const fixture = harness.createGitRepoFixture([
          { path: "anchor.txt", before: "anchor\n", after: "anchor\n" },
        ]);
        const source = sourceLines(scenario.lines);
        expect(source.split("\n").length - 1).toBe(scenario.lines);
        if (scenario.lines === 20_000) expect(Buffer.byteLength(source)).toBe(848_889);
        writeFileSync(join(fixture.dir, "sample.ts"), source);
        const staged = Bun.spawnSync(
          ["git", "-c", "core.hooksPath=/dev/null", "add", "sample.ts"],
          {
            cwd: fixture.dir,
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        expect(staged.exitCode).toBe(0);
        session = await harness.launchHunk({
          args: [
            "diff",
            "HEAD",
            "--mode",
            mode,
            "--theme",
            "github-dark-default",
            ...(scenario.wrap ? ["--wrap"] : []),
          ],
          cwd: fixture.dir,
          cols: 160,
          rows: 48,
        });
        if (scenario.guarded) {
          const guarded = await session.waitForText(/File too large to render automatically/, {
            timeout: 5_000,
          });
          expect(guarded).not.toContain("BIGFILE_FIRST_MARKER");
          return;
        }
        await session.waitForText(/BIGFILE_FIRST_MARKER/, { timeout: 15_000 });
        await harness.ensureKeyboardIsLive(session);
        await session.press("end");
        const bottom = await session.waitForText(/BIGFILE_LAST_MARKER/, { timeout: 3_000 });
        expect(bottom).not.toContain("BIGFILE_FIRST_MARKER");
        await session.press("home");
        const first = await session.waitForText(/BIGFILE_FIRST_MARKER/, { timeout: 3_000 });
        expect(first).not.toContain("BIGFILE_LAST_MARKER");
      } finally {
        try {
          session?.close();
        } finally {
          harness.cleanup();
        }
      }
    });
  }
}
