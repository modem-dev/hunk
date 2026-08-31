import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildJjDiffArgs,
  buildJjShowArgs,
  resolveJjDiffEndpoints,
  resolveJjRangeEndpoints,
  runJjText,
} from "./commands";
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
  test("compares named revisions with --from/--to rather than a range revset", () => {
    const input = diffInput({ rangeEndpoints: { from: "main", to: "feature" } });
    expect(buildJjDiffArgs(input)).toEqual([
      "diff",
      "--git",
      "--ignore-working-copy",
      "--from",
      "main",
      "--to",
      "feature",
    ]);
    expect(buildJjDiffArgs(input, undefined, true)).toEqual([
      "diff",
      "--git",
      "--from",
      "main",
      "--to",
      "feature",
    ]);
  });

  test("rejects each option-like Jujutsu endpoint before commands or revision probes", () => {
    for (const rangeEndpoints of [
      { from: "--from-file", to: "feature" },
      { from: "main", to: "--to-file" },
    ]) {
      const input = diffInput({ rangeEndpoints });
      expect(() => buildJjDiffArgs(input)).toThrow("looks like a Jujutsu option");
      expect(() => resolveJjRangeEndpoints(input, rangeEndpoints)).toThrow(
        "looks like a Jujutsu option",
      );
    }

    for (const rangeEndpoints of [
      { from: "", to: "feature" },
      { from: "main", to: "" },
    ]) {
      const input = diffInput({ rangeEndpoints });
      expect(() => buildJjDiffArgs(input)).toThrow("empty revision");
      expect(() => resolveJjRangeEndpoints(input, rangeEndpoints)).toThrow("empty revision");
    }
  });

  test("passes an explicitly written revset through to -r", () => {
    expect(buildJjDiffArgs(diffInput({ range: "trunk()..@" }))).toEqual([
      "diff",
      "--git",
      "-r",
      "trunk()..@",
    ]);
  });

  test("uses an immutable revision override without changing fileset arguments", () => {
    expect(buildJjDiffArgs(diffInput({ pathspecs: ["src/a b.ts"] }), "abc123")).toEqual([
      "diff",
      "--git",
      "-r",
      "abc123",
      "--",
      "src/a b.ts",
    ]);
    expect(
      buildJjShowArgs(
        { kind: "show", ref: "moving", pathspecs: ["-odd.ts"], options: {} },
        "abc123",
      ),
    ).toEqual(["diff", "--git", "-r", "abc123", "--", "-odd.ts"]);
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

  jjTest("resolves a single revision to immutable commit and parent endpoints", () => {
    const dir = createTempJjRepo("hunk-jj-endpoints-");
    writeFileSync(join(dir, "file.txt"), "one\n");
    jj(dir, "commit", "-m", "first");
    const firstCommitId = jj(dir, "log", "--no-graph", "-r", "@-", "-T", "commit_id");
    writeFileSync(join(dir, "file.txt"), "two\n");
    const secondCommitId = jj(dir, "log", "--no-graph", "-r", "@", "-T", "commit_id");

    expect(resolveJjDiffEndpoints(diffInput(), "@", { cwd: dir })).toEqual({
      newCommitId: secondCommitId,
      oldCommitIds: [firstCommitId],
    });
  });

  jjTest("ignores template aliases when resolving immutable endpoints", () => {
    const dir = createTempJjRepo("hunk-jj-endpoints-template-alias-");
    writeFileSync(join(dir, "file.txt"), "one\n");
    jj(dir, "commit", "-m", "first");
    const firstCommitId = jj(dir, "log", "--no-graph", "-r", "@-", "-T", "self.commit_id()");

    writeFileSync(join(dir, "file.txt"), "two\n");
    jj(dir, "commit", "-m", "second");
    const secondCommitId = jj(dir, "log", "--no-graph", "-r", "@-", "-T", "self.commit_id()");

    writeFileSync(join(dir, "file.txt"), "three\n");
    const thirdCommitId = jj(dir, "log", "--no-graph", "-r", "@", "-T", "self.commit_id()");
    jj(dir, "config", "set", "--repo", "template-aliases.commit_id", `'"${firstCommitId}"'`);

    expect(resolveJjDiffEndpoints(diffInput(), "@", { cwd: dir })).toEqual({
      newCommitId: thirdCommitId,
      oldCommitIds: [secondCommitId],
    });
  });

  jjTest("resolves two revisions to immutable source-expansion endpoints", () => {
    const dir = createTempJjRepo("hunk-jj-two-endpoints-");
    writeFileSync(join(dir, "file.txt"), "one\n");
    jj(dir, "commit", "-m", "first");
    const from = jj(dir, "log", "--no-graph", "-r", "@-", "-T", "commit_id");
    writeFileSync(join(dir, "file.txt"), "two\n");
    const to = jj(dir, "log", "--no-graph", "-r", "@", "-T", "commit_id");
    const input = diffInput({ rangeEndpoints: { from: "@-", to: "@" } });

    expect(resolveJjRangeEndpoints(input, input.rangeEndpoints!, { cwd: dir })).toEqual({
      newCommitId: to,
      oldCommitIds: [from],
    });
  });

  jjTest("omits endpoints when a revset resolves to multiple revisions", () => {
    const dir = createTempJjRepo("hunk-jj-endpoints-multi-");
    writeFileSync(join(dir, "file.txt"), "one\n");
    jj(dir, "commit", "-m", "first");
    writeFileSync(join(dir, "file.txt"), "two\n");
    jj(dir, "commit", "-m", "second");

    expect(resolveJjDiffEndpoints(diffInput(), "@- | @--", { cwd: dir })).toBeUndefined();
  });

  jjTest("marks a merge base as synthesized instead of choosing one parent", () => {
    const dir = createTempJjRepo("hunk-jj-endpoints-merge-");
    writeFileSync(join(dir, "base.txt"), "base\n");
    jj(dir, "commit", "-m", "base");
    const baseCommitId = jj(dir, "log", "--no-graph", "-r", "@-", "-T", "commit_id");

    writeFileSync(join(dir, "left.txt"), "left\n");
    jj(dir, "commit", "-m", "left");
    const leftCommitId = jj(dir, "log", "--no-graph", "-r", "@-", "-T", "commit_id");

    jj(dir, "new", baseCommitId);
    writeFileSync(join(dir, "right.txt"), "right\n");
    jj(dir, "commit", "-m", "right");
    const rightCommitId = jj(dir, "log", "--no-graph", "-r", "@-", "-T", "commit_id");

    jj(dir, "new", leftCommitId, rightCommitId);
    writeFileSync(join(dir, "merge.txt"), "merge\n");
    const mergeCommitId = jj(dir, "log", "--no-graph", "-r", "@", "-T", "commit_id");
    const endpoints = resolveJjDiffEndpoints(diffInput(), "@", { cwd: dir });

    expect(endpoints).toEqual({
      newCommitId: mergeCommitId,
      oldCommitIds: [leftCommitId, rightCommitId].sort(),
    });
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
