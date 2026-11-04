import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

setDefaultTimeout(30_000);

function runGit(args: string[], cwd: string) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
}

/** Change a declared file, a built-in lockfile the repo opts out, and ordinary code. */
function createAttributedFixture(dir: string) {
  runGit(["init"], dir);
  runGit(["config", "user.name", "Pi"], dir);
  runGit(["config", "user.email", "pi@example.com"], dir);
  runGit(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(
    join(dir, ".gitattributes"),
    "client.ts linguist-generated\nyarn.lock -linguist-generated\n",
  );
  writeFileSync(join(dir, "client.ts"), "export const declared = 1;\n");
  writeFileSync(join(dir, "plain.ts"), "export const ordinary = 1;\n");
  writeFileSync(join(dir, "uv.lock"), "builtin = 1\n");
  writeFileSync(join(dir, "yarn.lock"), "optedOut = 1\n");
  runGit(["add", "."], dir);
  runGit(["commit", "-qm", "base"], dir);
  writeFileSync(join(dir, "client.ts"), "export const declared = 2;\n");
  writeFileSync(join(dir, "plain.ts"), "export const ordinary = 2;\n");
  writeFileSync(join(dir, "uv.lock"), "builtin = 2\n");
  writeFileSync(join(dir, "yarn.lock"), "optedOut = 2\n");
}

/** Launch one review over the fixture and wait for the ordinary file's diff. */
async function launchFixtureReview(
  harness: ReturnType<typeof createPtyHarness>,
  fixtureDir: string,
  extraArgs: string[] = [],
) {
  const session = await harness.launchHunk({
    args: ["diff", "--mode", "unified", "--theme", "github-dark-default", ...extraArgs],
    cwd: fixtureDir,
    cols: 140,
    rows: 40,
  });
  await harness.ensureKeyboardIsLive(session);
  await session.waitForText(/ordinary = 2/, { timeout: 10_000 });
  return session;
}

test("collapses linguist-generated files and toggles them by key and mouse", async () => {
  const harness = createPtyHarness();
  const fixtureDir = mkdtempSync(join(tmpdir(), "hunk-collapse-"));
  let session: Awaited<ReturnType<typeof harness.launchHunk>> | undefined;
  try {
    createAttributedFixture(fixtureDir);
    session = await launchFixtureReview(harness, fixtureDir);

    const initial = await harness.waitForSnapshot(
      session,
      (text) => text.includes("Generated file collapsed") && text.includes("Lockfile collapsed"),
      10_000,
    );
    expect(initial).not.toContain("declared = 2");
    expect(initial).not.toContain("builtin = 2");
    expect(initial).toContain("ordinary = 2");
    expect(initial).toContain("optedOut = 2");

    // The first file in the stream is selected, so `Z` reveals the declared file.
    session.writeRaw("Z");
    const expanded = await harness.waitForSnapshot(
      session,
      (text) => text.includes("declared = 2"),
      10_000,
    );
    expect(expanded).not.toContain("Generated file collapsed");

    session.writeRaw("Z");
    await harness.waitForSnapshot(
      session,
      (text) => !text.includes("declared = 2") && text.includes("Generated file collapsed"),
      10_000,
    );

    const clicked = await harness.clickAndWaitForSnapshot(
      session,
      /Lockfile collapsed/,
      (text) => text.includes("builtin = 2"),
      { timeout: 10_000 },
    );
    expect(clicked).toContain("builtin = 2");
  } finally {
    session?.close();
    rmSync(fixtureDir, { recursive: true, force: true });
    harness.cleanup();
  }
});

test("--no-collapse-generated shows every diff in full", async () => {
  const harness = createPtyHarness();
  const fixtureDir = mkdtempSync(join(tmpdir(), "hunk-collapse-off-"));
  let session: Awaited<ReturnType<typeof harness.launchHunk>> | undefined;
  try {
    createAttributedFixture(fixtureDir);
    session = await launchFixtureReview(harness, fixtureDir, ["--no-collapse-generated"]);

    const snapshot = await harness.waitForSnapshot(
      session,
      (text) => text.includes("declared = 2") && text.includes("builtin = 2"),
      10_000,
    );
    expect(snapshot).not.toContain("collapsed ·");
  } finally {
    session?.close();
    rmSync(fixtureDir, { recursive: true, force: true });
    harness.cleanup();
  }
});
