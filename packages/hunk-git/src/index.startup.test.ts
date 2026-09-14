import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as asyncProcess from "@hunk/vcs/async-process";
import { GitVcsAdapter } from ".";

/** Hold stats open while the adapter starts its other read-only startup queries. */
function createTestStartupReads(failConfig = false) {
  const repo = mkdtempSync(join(tmpdir(), "hunk-git-startup-"));
  writeFileSync(join(repo, "untracked.txt"), "fresh\n");
  const commands: string[][] = [];
  let releaseStats!: () => void;
  const statsGate = new Promise<void>((resolve) => {
    releaseStats = resolve;
  });
  const commandSpy = spyOn(asyncProcess, "runAbortableCommand").mockImplementation(
    async (command, { signal }) => {
      commands.push(command);
      let stdout = "";
      if (command.includes("--show-toplevel")) stdout = `${repo}\n`;
      else if (command.includes("--numstat")) {
        await statsGate;
        signal?.throwIfAborted();
        stdout = "20001\t0\thuge.txt\0";
      } else if (command.includes("config")) {
        if (failConfig) throw new Error("config read failed");
        stdout = command.includes("diff.colorMoved") ? "zebra\n" : "allow-indentation-change\n";
      } else if (command.includes("ls-files")) stdout = "100644 abc 0\ttracked.txt\0";
      else if (command.includes("status")) stdout = "?? untracked.txt\0";
      else if (command.includes("diff")) stdout = "test patch";
      else throw new Error(`Unexpected Git command: ${command.join(" ")}`);
      return { stdout, stderr: "", exitCode: 0 };
    },
  );
  return {
    repo,
    commands,
    releaseStats,
    cleanup() {
      releaseStats();
      commandSpy.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

/** Drain promise-only command continuations without imposing a performance threshold. */
async function flushTestStartupReads() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("overlaps independent Git startup reads but waits for stats before generating a patch", async () => {
  const fixture = createTestStartupReads();
  const load = GitVcsAdapter.operations["working-tree-diff"]!.load(
    { kind: "vcs", staged: false, options: {} },
    { cwd: fixture.repo },
  );
  try {
    await flushTestStartupReads();
    for (const argument of ["--numstat", "diff.colorMovedWS", "ls-files", "status"]) {
      expect(fixture.commands.some((command) => command.includes(argument))).toBe(true);
    }
    expect(fixture.commands.filter((command) => command.includes("diff"))).toHaveLength(1);

    fixture.releaseStats();
    const result = await load;
    const patchCommand = fixture.commands.find(
      (command) => command.includes("diff") && !command.includes("--numstat"),
    );
    expect(patchCommand).toContain(":(exclude)huge.txt");
    expect(patchCommand).toContain("--color-moved=zebra");
    expect(patchCommand).toContain("--color-moved-ws=allow-indentation-change");
    expect(result.patchText).toBe("test patch");
    expect(result.untrackedPaths).toEqual(["untracked.txt"]);
    expect(result.sourceCacheKey).toContain("git-source-v1:index:");
    expect(result.readFileSource).toBeFunction();
    expect(result.extraFiles).toEqual([
      {
        kind: "skipped",
        path: "huge.txt",
        reason: "too-large",
        changeType: "change",
        stats: { additions: 20001, deletions: 0 },
      },
    ]);
  } finally {
    fixture.releaseStats();
    await Promise.allSettled([load]);
    fixture.cleanup();
  }
});

for (const failure of ["command", "cancellation"] as const) {
  test(`settles every started Git read before returning a startup ${failure}`, async () => {
    const fixture = createTestStartupReads(failure === "command");
    const controller = new AbortController();
    let settled = false;
    const outcome = Promise.resolve(
      GitVcsAdapter.operations["working-tree-diff"]!.load(
        { kind: "vcs", staged: false, options: {} },
        { cwd: fixture.repo, signal: controller.signal },
      ),
    ).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await flushTestStartupReads();
      if (failure === "cancellation") controller.abort(new Error("startup cancelled"));
      await flushTestStartupReads();
      expect(settled).toBe(false);
      fixture.releaseStats();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        failure === "command" ? "config read failed" : "startup cancelled",
      );
      expect(
        fixture.commands.some(
          (command) => command.includes("diff") && !command.includes("--numstat"),
        ),
      ).toBe(false);
    } finally {
      fixture.releaseStats();
      await outcome;
      fixture.cleanup();
    }
  });
}
