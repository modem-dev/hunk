import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createSaplingVcsAdapter, SaplingVcsAdapter } from ".";
import type {
  ExtensionVcsOperations,
  ExtensionVcsShowInput,
  ExtensionVcsDiffInput,
} from "hunkdiff/extension";

// The adapter is written against the published contract, so the tests read it
// through that contract too — including the operations an adapter may omit.
const slOperations: ExtensionVcsOperations = SaplingVcsAdapter.operations;

const slAvailable = (() => {
  try {
    return (
      Bun.spawnSync(["sl", "version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
        .exitCode === 0
    );
  } catch {
    return false;
  }
})();
const tempDirs: string[] = [];
const SlAdapterIntegrationTestTimeoutMs = 20_000;

function createTempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** Normalize Windows short/long temp path spellings before path equality assertions. */
function normalizeComparablePath(path: string) {
  const resolvedPath = platform() === "win32" ? realpathSync.native(path) : path;
  return resolvedPath.replace(/\\/g, "/");
}

function sl(cwd: string, ...cmd: string[]) {
  const proc = Bun.spawnSync(["sl", "--noninteractive", "--color", "never", ...cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr).toString("utf8");
    throw new Error(stderr.trim() || `sl ${cmd.join(" ")} failed`);
  }

  return Buffer.from(proc.stdout).toString("utf8");
}

function createTempSlRepo(prefix: string) {
  const dir = createTempDir(prefix);
  sl(dir, "init", "--git");
  sl(dir, "config", "--local", "ui.username", "Test User <test@example.com>");
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("SaplingVcsAdapter", () => {
  test("detects Sapling repositories from nested directories", () => {
    const repo = createTempDir("hunk-sl-adapter-detect-");
    mkdirSync(join(repo, ".sl"));
    const nested = join(repo, "src", "nested");
    mkdirSync(nested, { recursive: true });

    expect(SaplingVcsAdapter.detect(nested)).toEqual({ id: "sl", repoRoot: repo });
  });

  test("auto-detects .hg directories with treestate as Sapling", () => {
    const repo = createTempDir("hunk-sl-adapter-hg-treestate-");
    mkdirSync(join(repo, ".hg"));
    writeFileSync(join(repo, ".hg", "requires"), "revlogv1\nstore\ntreestate\n");

    expect(SaplingVcsAdapter.detect(repo)).toEqual({ id: "sl", repoRoot: repo });
  });

  test("does not auto-detect .hg directories without treestate", () => {
    const repo = createTempDir("hunk-sl-adapter-hg-upstream-");
    mkdirSync(join(repo, ".hg"));
    writeFileSync(join(repo, ".hg", "requires"), "revlogv1\nstore\n");

    expect(SaplingVcsAdapter.detect(repo)).toBeNull();
  });

  test.skipIf(process.platform === "win32")(
    "pins revision-show patches to the node resolved for metadata",
    async () => {
      const repo = createTempDir("hunk-sl-adapter-pinned-show-");
      const executable = join(repo, "fake-sl");
      const callsPath = join(repo, "calls.txt");
      const revision = "a".repeat(40);
      writeFileSync(
        executable,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}`,
          'case " $* " in',
          `  *" root "*) printf '%s\\n' ${JSON.stringify(repo)} ;;`,
          `  *" log "*) printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0' ${JSON.stringify(revision)} ${JSON.stringify(revision.slice(0, 12))} 'Pinned commit' 'Test User' 'test@example.com' '2026-09-08 12:00:00 +0000' ;;`,
          `  *" diff "*) printf 'pinned patch\\n' ;;`,
          "  *) exit 1 ;;",
          "esac",
          "",
        ].join("\n"),
      );
      chmodSync(executable, 0o755);

      const adapter = createSaplingVcsAdapter({ slExecutable: executable });
      const result = await adapter.operations["revision-show"]!.load(
        { kind: "show", ref: ".", options: {} },
        { cwd: repo },
      );

      expect(result.review).toMatchObject({ revision, title: "Pinned commit" });
      expect(result.patchText).toBe("pinned patch\n");
      expect(readFileSync(callsPath, "utf8")).toContain(`diff --git --change ${revision}`);
    },
  );

  test.skipIf(process.platform === "win32")(
    "pins comparison patches to the nodes resolved for metadata",
    async () => {
      const repo = createTempDir("hunk-sl-adapter-pinned-comparison-");
      const executable = join(repo, "fake-sl");
      const callsPath = join(repo, "calls.txt");
      const baseRevision = "a".repeat(40);
      const headRevision = "b".repeat(40);
      const record = (revision: string, title: string) =>
        `printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0' ${JSON.stringify(revision)} ${JSON.stringify(revision.slice(0, 12))} ${JSON.stringify(title)} 'Test User' 'test@example.com' '2026-09-08 12:00:00 +0000'`;
      writeFileSync(
        executable,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}`,
          'case " $* " in',
          `  *" root "*) printf '%s\\n' ${JSON.stringify(repo)} ;;`,
          `  *" log -r only("*) ${record(headRevision, "Head commit")} ;;`,
          `  *" log -r base "*) ${record(baseRevision, "Base commit")} ;;`,
          `  *" log -r head "*) ${record(headRevision, "Head commit")} ;;`,
          `  *" diff "*) printf 'pinned comparison patch\\n' ;;`,
          "  *) exit 1 ;;",
          "esac",
          "",
        ].join("\n"),
      );
      chmodSync(executable, 0o755);

      const adapter = createSaplingVcsAdapter({ slExecutable: executable });
      const result = await adapter.operations["working-tree-diff"]!.load(
        {
          kind: "vcs",
          staged: false,
          rangeEndpoints: { from: "base", to: "head" },
          options: {},
        },
        { cwd: repo },
      );

      expect(result.review).toMatchObject({ base: baseRevision, head: headRevision });
      expect(result.patchText).toBe("pinned comparison patch\n");
      expect(readFileSync(callsPath, "utf8")).toContain(
        `diff --git -r ${baseRevision} -r ${headRevision}`,
      );
    },
  );

  test.skipIf(!slAvailable)(
    "loads working-copy and revision patches through neutral operations",
    async () => {
      const repo = createTempSlRepo("hunk-sl-adapter-review-");
      writeFileSync(join(repo, "file.txt"), "one\n");
      sl(repo, "add", "file.txt");
      sl(repo, "commit", "-m", "initial");
      writeFileSync(join(repo, "file.txt"), "two\n");

      const diffInput = {
        kind: "vcs",
        staged: false,
        options: {},
      } satisfies ExtensionVcsDiffInput;
      const diffResult = await SaplingVcsAdapter.operations["working-tree-diff"]!.load(diffInput, {
        cwd: repo,
      });

      expect(normalizeComparablePath(diffResult.repoRoot)).toBe(normalizeComparablePath(repo));
      expect(diffResult.title).toContain("working copy");
      expect(diffResult.patchText).toContain("diff --git a/file.txt b/file.txt");
      expect(diffResult.patchText).toContain("+two");
      expect(diffResult.review).toBeUndefined();

      const showInput = {
        kind: "show",
        ref: ".",
        options: {},
      } satisfies ExtensionVcsShowInput;
      const showResult = await SaplingVcsAdapter.operations["revision-show"]!.load(showInput, {
        cwd: repo,
      });

      expect(showResult.title).toContain("show .");
      expect(showResult.patchText).toContain("diff --git a/file.txt b/file.txt");
      expect(showResult.review).toMatchObject({
        kind: "commit",
        provider: "Sapling",
        title: "initial",
        displayRevision: expect.stringMatching(/^[0-9a-f]{12}$/),
        author: "test",
      });
      expect(
        SaplingVcsAdapter.operations["working-tree-diff"]!.watchSignature!(diffInput, {
          cwd: repo,
        }),
      ).toContain("+two");
      expect(
        SaplingVcsAdapter.operations["revision-show"]!.watchSignature!(showInput, { cwd: repo }),
      ).toContain("diff --git");
    },
    SlAdapterIntegrationTestTimeoutMs,
  );

  test.skipIf(!slAvailable)(
    "describes direct Sapling revision comparisons with included commits",
    async () => {
      const repo = createTempSlRepo("hunk-sl-adapter-comparison-");
      writeFileSync(join(repo, "file.txt"), "one\n");
      sl(repo, "add", "file.txt");
      sl(repo, "commit", "-m", "initial");
      const from = sl(repo, "log", "-r", ".", "--template", "{node}");
      writeFileSync(join(repo, "file.txt"), "two\n");
      sl(repo, "commit", "-m", "second");
      const to = sl(repo, "log", "-r", ".", "--template", "{node}");
      const input = {
        kind: "vcs",
        rangeEndpoints: { from, to },
        staged: false,
        options: {},
      } satisfies ExtensionVcsDiffInput;

      const result = await SaplingVcsAdapter.operations["working-tree-diff"]!.load(input, {
        cwd: repo,
      });

      expect(result.review).toMatchObject({
        kind: "comparison",
        provider: "Sapling",
        base: from,
        head: to,
        title: "1 commit",
        commitCount: 1,
        commits: [{ title: "second", revision: to }],
      });
    },
    SlAdapterIntegrationTestTimeoutMs,
  );

  test.skipIf(!slAvailable)(
    "rejects staged and stash operations",
    async () => {
      const repo = createTempSlRepo("hunk-sl-adapter-unsupported-");
      const stagedInput = {
        kind: "vcs",
        staged: true,
        options: {},
      } satisfies ExtensionVcsDiffInput;
      await expect(
        SaplingVcsAdapter.operations["working-tree-diff"]!.load(stagedInput, { cwd: repo }),
      ).rejects.toThrow("Sapling has no staging area");
      expect(slOperations["stash-show"]).toBeUndefined();
    },
    SlAdapterIntegrationTestTimeoutMs,
  );
});

// These branches run before any `sl` invocation, so they need no external binary.
describe("SaplingVcsAdapter without the sl binary", () => {
  test("adapter range loads do not probe working-copy unknown files", async () => {
    const repo = createTempDir("hunk-sl-adapter-range-untracked-");
    const commands: string[][] = [];
    const mutableBun = Bun as unknown as {
      spawnSync: typeof Bun.spawnSync;
      spawn: typeof Bun.spawn;
    };
    const originalSpawnSync = mutableBun.spawnSync;
    const originalSpawn = mutableBun.spawn;
    mutableBun.spawnSync = ((command: string[]) => {
      commands.push(command);
      const operation = command.slice(4);
      const stdout = operation[0] === "root" ? `${repo}\n` : "";
      return { exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.from("") };
    }) as typeof Bun.spawnSync;
    mutableBun.spawn = ((command: string[]) => {
      commands.push(command);
      const operation = command.slice(4);
      const stdout = operation[0] === "root" ? `${repo}\n` : "";
      return {
        stdout: new Blob([stdout]).stream(),
        stderr: new Blob([""]).stream(),
        exited: Promise.resolve(0),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;

    try {
      const input = {
        kind: "vcs",
        rangeEndpoints: { from: "main", to: "feature" },
        staged: false,
        options: {},
      } satisfies ExtensionVcsDiffInput;
      const result = await SaplingVcsAdapter.operations["working-tree-diff"]!.load(input, {
        cwd: repo,
      });

      expect(result.untrackedPaths).toEqual([]);
      expect(commands.some((command) => command.includes("status"))).toBe(false);
      expect(
        commands.some((command) => command.includes("main") && command.includes("feature")),
      ).toBe(true);
    } finally {
      mutableBun.spawnSync = originalSpawnSync;
      mutableBun.spawn = originalSpawn;
    }
  });

  test("treats a .hg directory with no requires file as non-Sapling", () => {
    const repo = createTempDir("hunk-sl-hg-no-requires-");
    mkdirSync(join(repo, ".hg"));
    // No `.hg/requires` file, so the Sapling check reads a missing file and falls back to false.
    expect(SaplingVcsAdapter.detect(repo)).toBeNull();
  });

  test("returns null when no Sapling marker exists up to the filesystem root", () => {
    expect(SaplingVcsAdapter.detect(createTempDir("hunk-sl-detect-none-"))).toBeNull();
  });

  test("rejects option-like endpoints from direct adapter callers before spawning sl", async () => {
    const input = {
      kind: "vcs",
      rangeEndpoints: { from: "main", to: "--config=unsafe" },
      staged: false,
      options: {},
    } satisfies ExtensionVcsDiffInput;
    await expect(
      SaplingVcsAdapter.operations["working-tree-diff"]!.load(input, { cwd: tmpdir() }),
    ).rejects.toThrow("looks like a Sapling option");
  });

  test("rejects staged working-tree diffs before spawning sl", async () => {
    const stagedInput = {
      kind: "vcs",
      staged: true,
      options: {},
    } satisfies ExtensionVcsDiffInput;
    await expect(
      SaplingVcsAdapter.operations["working-tree-diff"]!.load(stagedInput, { cwd: tmpdir() }),
    ).rejects.toThrow("Sapling has no staging area");
  });

  test("does not expose a stash-show operation", () => {
    expect(slOperations["stash-show"]).toBeUndefined();
  });
});
