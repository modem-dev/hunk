import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJjDiffArgs, runJjText } from "./commands";
import type { ExtensionVcsDiffInput as VcsDiffCommandInput } from "hunkdiff/extension";

const tempDirs: string[] = [];
// Windows subprocess setup can exceed Bun's default 5s timeout while generating enough jj changes.
const JjAmbiguousPrefixTestTimeoutMs = 20_000;

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Build one working-tree review input for the jj command helpers. */
function diffInput(overrides: Partial<VcsDiffCommandInput> = {}): VcsDiffCommandInput {
  return { kind: "vcs", staged: false, options: {}, ...overrides };
}

function createTempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function jj(cwd: string, ...cmd: string[]) {
  const proc = Bun.spawnSync(
    [
      "jj",
      "--config",
      "signing.behavior=drop",
      "--config",
      'user.name="Test User"',
      "--config",
      "user.email=test@example.com",
      ...cmd,
    ],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );

  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr).toString("utf8");
    throw new Error(stderr.trim() || `jj ${cmd.join(" ")} failed`);
  }

  return Buffer.from(proc.stdout).toString("utf8");
}

function createTempJjRepo(prefix: string) {
  const dir = createTempDir(prefix);

  jj(tmpdir(), "git", "init", "--colocate", dir);

  return dir;
}

function findDuplicatePrefix(values: string[]) {
  const seen = new Set<string>();

  for (const value of values) {
    const prefix = value[0];
    if (!prefix) {
      continue;
    }

    if (seen.has(prefix)) {
      return prefix;
    }

    seen.add(prefix);
  }

  return undefined;
}

afterEach(() => {
  cleanupTempDirs();
});

// Keep jj-backed integration checks opt-in on machines that have the external CLI installed.
const jjTest = Bun.which("jj") ? test : test.skip;

describe("jj command helpers", () => {
  test("compares two named revisions with --from/--to rather than a `..` revset", () => {
    expect(buildJjDiffArgs(diffInput({ rangeEndpoints: { from: "main", to: "feature" } }))).toEqual(
      ["diff", "--git", "--from", "main", "--to", "feature"],
    );
  });

  test("passes a revset the user spelled straight through to -r", () => {
    expect(buildJjDiffArgs(diffInput({ range: "trunk()..@" }))).toEqual([
      "diff",
      "--git",
      "-r",
      "trunk()..@",
    ]);
  });

  jjTest("keeps the from-side removals of two diverged revisions", () => {
    const dir = createTempJjRepo("hunk-jj-diverged-endpoints-");
    writeFileSync(join(dir, "base.txt"), "base\n");
    jj(dir, "commit", "-m", "base");
    jj(dir, "bookmark", "create", "base", "-r", "@-");

    writeFileSync(join(dir, "only-on-a.txt"), "a\n");
    jj(dir, "commit", "-m", "a");
    jj(dir, "bookmark", "create", "a", "-r", "@-");

    jj(dir, "new", "base", "-m", "b");
    writeFileSync(join(dir, "only-on-b.txt"), "b\n");
    jj(dir, "commit", "-m", "b");
    jj(dir, "bookmark", "create", "b", "-r", "@-");

    const input = diffInput({ rangeEndpoints: { from: "a", to: "b" } });
    const patch = runJjText({ input, args: buildJjDiffArgs(input), cwd: dir });

    // `jj diff -r a..b` would show only the b-side addition: the revset holds the
    // commits reachable from b but not from a, so nothing reverses a's own work.
    expect(patch).toContain("only-on-b.txt");
    expect(patch).toContain("deleted file");
    expect(patch).toContain("only-on-a.txt");
  });

  test("reports a friendly error when jj is not installed or not on PATH", () => {
    expect(() =>
      runJjText({
        input: diffInput(),
        args: ["root"],
        jjExecutable: "definitely-not-a-real-jj-binary",
      }),
    ).toThrow(
      'Jujutsu is required for `hunk diff` when `vcs = "jj"`, but `definitely-not-a-real-jj-binary` was not found in PATH.',
    );
  });

  jjTest("reports a friendly error outside a jj repository", () => {
    const dir = createTempDir("hunk-jj-nonrepo-");

    expect(() =>
      runJjText({
        input: diffInput(),
        args: ["root"],
        cwd: dir,
      }),
    ).toThrow('`hunk diff` must be run inside a Jujutsu repository when `vcs = "jj"`.');
  });

  jjTest("reports a friendly error for invalid revsets", () => {
    const dir = createTempJjRepo("hunk-jj-invalid-revset-");
    const input = diffInput({ range: "missing_revision" });

    expect(() =>
      runJjText({
        input,
        args: buildJjDiffArgs(input),
        cwd: dir,
      }),
    ).toThrow("`hunk diff missing_revision` could not resolve Jujutsu revset `missing_revision`.");
  });

  jjTest(
    "reports a friendly error for ambiguous change id prefixes",
    () => {
      const dir = createTempJjRepo("hunk-jj-ambiguous-prefix-");
      let prefix: string | undefined;

      for (let index = 0; index < 32 && !prefix; index += 1) {
        writeFileSync(join(dir, `file-${index}.txt`), `${index}\n`);
        jj(dir, "commit", "-m", `commit ${index}`);

        prefix = findDuplicatePrefix(
          jj(dir, "log", "--no-graph", "-T", 'change_id ++ "\n"').trim().split("\n"),
        );
      }

      if (!prefix) {
        throw new Error("Expected generated jj changes to include an ambiguous prefix.");
      }

      const input = diffInput({ range: prefix });

      expect(() =>
        runJjText({
          input,
          args: buildJjDiffArgs(input),
          cwd: dir,
        }),
      ).toThrow(`\`hunk diff ${prefix}\` could not resolve Jujutsu revset \`${prefix}\`.`);
    },
    JjAmbiguousPrefixTestTimeoutMs,
  );
});
