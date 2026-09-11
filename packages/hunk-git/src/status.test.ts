import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolveCanonicalPath } from "@hunk/vcs/path";
import { join } from "node:path";
import { createGitStatusCapability, parseGitStatus, parseGitStatusWorktrees } from "./status";

const dirs: string[] = [];
/** Create a portable Git fixture with local identity and a deterministic branch. */
function createTestRepo(commit = true) {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-status-test-"));
  dirs.push(cwd);
  testGit(cwd, "init", "-q", "-b", "main");
  testGit(cwd, "config", "user.name", "Status Test");
  testGit(cwd, "config", "user.email", "status@example.com");
  if (commit) {
    writeFileSync(join(cwd, "mixed.txt"), "one\n");
    testGit(cwd, "add", ".");
    testGit(cwd, "commit", "-qm", "initial");
  }
  return cwd;
}
/** Execute fixture mutations outside the read-only provider under test. */
function testGit(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
const capability = createGitStatusCapability();
const header = `# branch.oid ${"a".repeat(40)}\0# branch.head main\0`;
const object = "a".repeat(40);
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Git status porcelain", () => {
  test("retains mixed states, literal rename paths, Unicode, conflicts and submodules", () => {
    const result = parseGitStatus(
      header +
        `1 MM N... 100644 100644 100644 ${object} ${object} mixed path\0` +
        `2 RM N... 100644 100644 100644 ${object} ${object} R100 new\t名\npath\0old \\ path\0` +
        `u UU N... 100644 100644 100644 100644 ${object} ${object} ${object} conflict\0` +
        `1 .M SCMU 160000 160000 160000 ${object} ${object} submodule\0` +
        `? --not-an-option\0`,
    );
    expect(result.paths).toHaveLength(5);
    expect(result.paths[0]).toMatchObject({ index: "modified", worktree: "modified" });
    expect(result.paths[1]).toMatchObject({
      path: "new\t名\npath",
      previousPath: "old \\ path",
      index: "renamed",
      worktree: "modified",
    });
    expect(result.paths[2]!.conflict).toBe(true);
    expect(result.paths[3]!.submodule).toEqual({
      commitChanged: true,
      trackedChanges: true,
      untrackedChanges: true,
    });
    expect(result.paths[4]).toMatchObject({ path: "--not-an-option", worktree: "untracked" });
  });
  test("refuses truncation, duplicate paths and malformed states", () => {
    expect(() => parseGitStatus(header + "? partial")).toThrow("truncated");
    expect(() => parseGitStatus(header + "? same\0? same\0")).toThrow("duplicate");
    expect(parseGitStatus(header + "? \ufffd\0").paths[0]!.path).toBe("\ufffd");
    expect(() =>
      parseGitStatus(header + `1 ZZ N... 100644 100644 100644 ${object} ${object} bad\0`),
    ).toThrow("invalid status");
    expect(() =>
      parseGitStatus(header + `2 R. N... 100644 100644 100644 ${object} ${object} R100 target\0`),
    ).toThrow("rename source");
  });
  test("refuses oversized current status instead of publishing a partial path count", () => {
    const paths = Array.from({ length: 20_001 }, (_, index) => `? file-${index}\0`).join("");
    expect(() => parseGitStatus(header + paths)).toThrow("exceeds 20000");
  });
  test("parses NUL worktree metadata without treating path newlines as records", () => {
    expect(
      parseGitStatusWorktrees(
        "worktree root\n名 \\path\0HEAD abc\0branch refs/heads/main\0locked reason\nline\0\0worktree gone\0HEAD abc\0detached\0prunable missing\0\0",
      ),
    ).toEqual([
      {
        path: "root\n名 \\path",
        branch: "main",
        detached: false,
        bare: false,
        locked: "reason\nline",
      },
      { path: "gone", detached: true, bare: false, prunable: "missing" },
    ]);
    expect(() => parseGitStatusWorktrees("worktree cut\0")).toThrow("truncated");
  });
});

describe("Git workspace status reads", () => {
  test("counts mixed staging once, plans full comparisons and refuses stale plans without mutating the index", async () => {
    const cwd = createTestRepo();
    writeFileSync(join(cwd, "mixed.txt"), "two\n");
    testGit(cwd, "add", "mixed.txt");
    writeFileSync(join(cwd, "mixed.txt"), "three\n");
    writeFileSync(join(cwd, "新 file.txt"), "new\n");
    const before = statSync(join(cwd, ".git", "index")).mtimeMs;
    const snapshot = await capability.read({}, { cwd });
    expect(snapshot.changedPathCount).toBe(2);
    expect(snapshot.paths[0]).toMatchObject({
      path: "mixed.txt",
      index: "modified",
      worktree: "modified",
    });
    expect(snapshot.siblings).toEqual({ state: "loading" });
    expect(snapshot.reviewActions.map((action) => action.id)).toEqual(["staged", "unstaged"]);
    expect(await capability.planReview(snapshot, "staged", { cwd })).toEqual({
      cwd: snapshot.worktree.path,
      input: { kind: "vcs", staged: true, options: {} },
    });
    expect(statSync(join(cwd, ".git", "index")).mtimeMs).toBe(before);
    testGit(cwd, "add", "新 file.txt");
    await expect(capability.planReview(snapshot, "staged", { cwd })).rejects.toThrow("refresh");
  });
  test("reports detached and unborn HEAD explicitly", async () => {
    const cwd = createTestRepo(false);
    expect((await capability.read({}, { cwd })).head).toEqual({ kind: "unborn", name: "main" });
    writeFileSync(join(cwd, "file"), "one");
    testGit(cwd, "add", ".");
    testGit(cwd, "commit", "-qm", "first");
    testGit(cwd, "checkout", "-q", "--detach");
    const snapshot = await capability.read({}, { cwd });
    expect(snapshot.head.kind).toBe("detached");
    expect(snapshot.upstream).toEqual({ state: "ready", value: { kind: "detached" } });
  });
  test("distinguishes tracked, deleted and absent upstreams and uses only FETCH_HEAD mtime", async () => {
    const cwd = createTestRepo();
    expect((await capability.read({}, { cwd })).upstream).toEqual({
      state: "ready",
      value: { kind: "none" },
    });
    testGit(cwd, "config", "remote.origin.url", "https://example.invalid/not-contacted");
    testGit(cwd, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    testGit(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    testGit(cwd, "branch", "--set-upstream-to=origin/main");
    let snapshot = await capability.read({}, { cwd });
    expect(snapshot.upstream).toMatchObject({
      state: "ready",
      value: { kind: "tracked", ahead: 0, behind: 0, fetch: { state: "unknown" } },
    });
    const fetchedAt = new Date("2026-01-02T03:04:05Z");
    writeFileSync(join(cwd, ".git", "FETCH_HEAD"), "local fixture\n");
    utimesSync(join(cwd, ".git", "FETCH_HEAD"), fetchedAt, fetchedAt);
    snapshot = await capability.read({}, { cwd });
    expect(snapshot.upstream).toMatchObject({
      state: "ready",
      value: {
        fetch: {
          state: "ready",
          value: { timestamp: fetchedAt.toISOString(), provenance: "local-fetch-head-mtime" },
        },
      },
    });
    testGit(cwd, "update-ref", "-d", "refs/remotes/origin/main");
    expect((await capability.read({}, { cwd })).upstream).toMatchObject({
      state: "ready",
      value: { kind: "missing", name: "origin/main" },
    });
  });
  test("contains sibling failures, locked and missing worktrees and isolates per-worktree operations", async () => {
    const cwd = createTestRepo();
    const sibling = join(cwd, "..", `${cwd.split(/[\\/]/).at(-1)}-sibling`);
    dirs.push(sibling);
    const missing = `${sibling}-missing`;
    dirs.push(missing);
    testGit(cwd, "worktree", "add", "-qb", "sibling", sibling);
    testGit(cwd, "worktree", "add", "-qb", "missing", missing);
    testGit(cwd, "worktree", "lock", "--reason", "keep me", sibling);
    writeFileSync(join(sibling, "untracked.txt"), "change");
    const gitDir = testGit(sibling, "rev-parse", "--absolute-git-dir");
    mkdirSync(join(gitDir, "rebase-merge"));
    rmSync(missing, { force: true, recursive: true });
    const snapshot = await capability.read({}, { cwd });
    const result = await capability.readSiblings(snapshot, { cwd });
    expect(result.worktrees).toHaveLength(2);
    expect(result.worktrees.find((row) => row.branch === "sibling")).toMatchObject({
      locked: "keep me",
      inspectable: true,
      status: {
        state: "ready",
        changedPathCount: 1,
        operations: { state: "ready", value: ["rebase"] },
      },
    });
    expect(result.worktrees.find((row) => row.branch === "missing")).toMatchObject({
      inspectable: false,
      status: { state: "unavailable" },
    });
    expect(snapshot.operations).toEqual({ state: "ready", value: [] });
    const target = await capability.read({ targetPath: sibling }, { cwd });
    expect(target.worktree.repositoryId).toBe(snapshot.worktree.repositoryId);
    expect(
      (await capability.readSiblings(target, { cwd })).worktrees.some(
        (row) => row.worktree.path === snapshot.worktree.path,
      ),
    ).toBe(true);
    mkdirSync(join(sibling, "ignored-build"));
    writeFileSync(join(sibling, "ignored-build", "output.txt"), "ignored");
    writeFileSync(join(sibling, ".gitignore"), "ignored-build/\n");
    const watch = await capability.watchPlan!(target, { cwd });
    expect(watch.targets.map((target) => target.directory)).toContain(resolveCanonicalPath(gitDir));
    expect(watch.targets.find((entry) => entry.directory === target.worktree.path)).toMatchObject({
      ignoredRoots: [
        join(target.worktree.path, ".git"),
        join(target.worktree.path, "ignored-build"),
      ],
    });
  });
  test("uses one filesystem identity through aliased launches, reciprocal siblings and review plans", async () => {
    const cwd = createTestRepo();
    const root = mkdtempSync(join(tmpdir(), "hunk-status-alias-test-"));
    dirs.push(root);
    const alias = join(root, "origin-alias");
    const sibling = join(root, "sibling");
    const siblingAlias = join(root, "sibling-alias");
    // Junctions exercise Windows aliases without requiring symlink privileges.
    symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    testGit(alias, "worktree", "add", "-qb", "sibling", sibling);
    symlinkSync(sibling, siblingAlias, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(sibling, "untracked.txt"), "change");
    const snapshot = await capability.read({}, { cwd: alias });
    expect(snapshot.worktree).toEqual((await capability.read({}, { cwd })).worktree);
    const siblings = await capability.readSiblings(snapshot, { cwd: alias });
    expect(siblings.worktrees).toHaveLength(1);
    const target = await capability.read({ targetPath: siblingAlias }, { cwd: alias });
    expect(siblings.worktrees[0]!.worktree).toEqual(target.worktree);
    expect(target.worktree.path).toBe(resolveCanonicalPath(sibling));
    const reciprocal = await capability.readSiblings(target, { cwd: alias });
    expect(reciprocal.worktrees).toHaveLength(1);
    expect(reciprocal.worktrees[0]!.worktree).toEqual(snapshot.worktree);
    const roundTrip = await capability.read(
      { targetPath: reciprocal.worktrees[0]!.worktree.path },
      { cwd: siblingAlias },
    );
    expect(roundTrip.worktree).toEqual(snapshot.worktree);
    expect(await capability.planReview(target, "unstaged", { cwd: alias })).toEqual({
      cwd: target.worktree.path,
      input: { kind: "vcs", staged: false, options: {} },
    });
  });

  test("limits concurrent sibling reads and contains an error to its row", async () => {
    const cwd = createTestRepo();
    const parent = mkdtempSync(join(tmpdir(), "hunk-status-siblings-test-"));
    dirs.push(parent);
    for (let index = 0; index < 6; index++)
      testGit(cwd, "worktree", "add", "-qb", `sibling-${index}`, join(parent, `sibling-${index}`));
    const provider = createGitStatusCapability();
    const snapshot = await provider.read({}, { cwd });
    const read = provider.read;
    let active = 0;
    let maximum = 0;
    provider.read = async (input, context) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await Bun.sleep(5);
        if (input.targetPath?.endsWith("sibling-2")) throw new Error("Sibling access failed");
        return await read(input, context);
      } finally {
        active--;
      }
    };
    const result = await provider.readSiblings(snapshot, { cwd });
    expect(maximum).toBe(4);
    expect(active).toBe(0);
    expect(result.worktrees.filter((row) => row.status.state === "ready")).toHaveLength(5);
    expect(result.worktrees.find((row) => row.branch === "sibling-2")).toMatchObject({
      inspectable: false,
      status: { state: "error", message: "Error: Sibling access failed" },
    });
  });

  test("recognizes conflict and operation markers without showing clean", async () => {
    const cwd = createTestRepo();
    for (const [marker, kind] of [
      ["MERGE_HEAD", "merge"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
    ] as const) {
      writeFileSync(join(cwd, ".git", marker), `${testGit(cwd, "rev-parse", "HEAD")}\n`);
      expect((await capability.read({}, { cwd })).operations).toMatchObject({
        state: "ready",
        value: [kind],
      });
      rmSync(join(cwd, ".git", marker));
    }
    mkdirSync(join(cwd, ".git", "sequencer"));
    writeFileSync(join(cwd, ".git", "sequencer", "todo"), `pick ${object} next\n`);
    expect((await capability.read({}, { cwd })).operations).toEqual({
      state: "ready",
      value: ["cherry-pick"],
    });
    writeFileSync(join(cwd, ".git", "sequencer", "todo"), "x".repeat(65_537));
    expect((await capability.read({}, { cwd })).operations.state).toBe("error");
    rmSync(join(cwd, ".git", "sequencer"), { recursive: true });
    testGit(cwd, "checkout", "-qb", "other");
    writeFileSync(join(cwd, "mixed.txt"), "other\n");
    testGit(cwd, "commit", "-qam", "other");
    testGit(cwd, "checkout", "-q", "main");
    writeFileSync(join(cwd, "mixed.txt"), "main\n");
    testGit(cwd, "commit", "-qam", "main");
    Bun.spawnSync(["git", "merge", "other"], { cwd, stdout: "pipe", stderr: "pipe" });
    const snapshot = await capability.read({}, { cwd });
    expect(snapshot.changedPathCount).toBe(1);
    expect(snapshot.paths[0]!.conflict).toBe(true);
    expect(snapshot.operations).toEqual({ state: "ready", value: ["merge"] });
  });
  test("rejects outside repositories, bare repositories, foreign targets and pre-cancelled reads", async () => {
    const cwd = createTestRepo();
    const foreign = createTestRepo();
    await expect(capability.read({ targetPath: foreign }, { cwd })).rejects.toThrow(
      "same Git repository",
    );
    const outside = mkdtempSync(join(tmpdir(), "hunk-outside-test-"));
    dirs.push(outside);
    await expect(capability.read({}, { cwd: outside })).rejects.toThrow("not a git repository");
    testGit(outside, "init", "--bare", "-q");
    await expect(capability.read({}, { cwd: outside })).rejects.toThrow("bare");
    const abort = new AbortController();
    abort.abort(new Error("cancelled status"));
    await expect(capability.read({}, { cwd, signal: abort.signal })).rejects.toThrow(
      "cancelled status",
    );
  });
});
