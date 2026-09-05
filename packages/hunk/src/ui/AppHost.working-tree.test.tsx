import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createTestWorkingTreeRepo, runTestGit } from "../../../../test/helpers/working-tree";
import { loadAppBootstrap } from "../core/changeset/loaders";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import { AppHost } from "./AppHost";
import { loadStartupExtensions } from "../extensions/startup";

setDefaultTimeout(30_000);
const roots: string[] = [];
let setup: Awaited<ReturnType<typeof testRender>> | undefined;

/** Render until the mounted review reflects the operation, not merely its Git subprocess. */
async function waitForReview(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await act(async () => {
      await setup!.renderOnce();
      await Bun.sleep(10);
    });
    if (predicate()) return;
  }
  throw new Error(`Review did not settle:\n${setup!.captureCharFrame()}`);
}

/** Start a real provider-backed review with one unstaged file and one staged file. */
async function createReview({
  beforeStage,
  onQuit,
  prepare,
  staged = false,
}: {
  beforeStage?: () => Promise<void>;
  onQuit?: () => void;
  prepare?: (root: string) => void;
  staged?: boolean;
} = {}) {
  const root = createTestWorkingTreeRepo();
  roots.push(root);
  writeFileSync(join(root, "alpha.txt"), "one\nchanged alpha\nthree\n");
  writeFileSync(join(root, "beta.txt"), "staged beta\n");
  runTestGit(root, "add", "beta.txt");
  prepare?.(root);
  const catalog = getBundledVcsCatalog();
  const vcsCatalog = beforeStage
    ? {
        ...catalog,
        adapters: catalog.adapters.map((adapter) => {
          const workingTree = adapter.operations["working-tree-diff"];
          if (!workingTree?.stageFile) return adapter;
          const stageFile = workingTree.stageFile;
          return {
            ...adapter,
            operations: {
              ...adapter.operations,
              "working-tree-diff": {
                ...workingTree,
                stageFile: async (...args: Parameters<typeof stageFile>) => {
                  await beforeStage();
                  await stageFile(...args);
                },
              },
            },
          };
        }),
      }
    : catalog;
  const bootstrap = await loadAppBootstrap(
    { kind: "vcs", staged, options: { mode: "stack", sidebar: true, extensions: false } },
    { cwd: root, vcsCatalog },
  );
  bootstrap.extensions = await loadStartupExtensions({
    cwd: root,
    extensions: { enabled: false, paths: [], repoPaths: [], extensionConfigs: {} },
  });
  setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={onQuit} />, {
    width: 150,
    height: 30,
  });
  await waitForReview(() => setup!.captureCharFrame().includes("Unstaged ("));
  return root;
}

/** Send one terminal key through App's real dispatch path. */
async function press(key: string) {
  await act(async () => {
    await setup!.mockInput.typeText(key);
  });
}

afterEach(async () => {
  if (setup) {
    const current = setup;
    setup = undefined;
    await act(async () => current.renderer.destroy());
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("working-tree stream actions", () => {
  test("an external edit after discard consent is shown refuses the stale target", async () => {
    const root = await createReview();
    await press("d");
    await waitForReview(() => setup!.captureCharFrame().includes("Discard changes"));
    writeFileSync(join(root, "alpha.txt"), "changed after prompt\n");
    await press("x");
    await waitForReview(() => setup!.captureCharFrame().includes("changed since"));
    expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("changed after prompt\n");
    expect(runTestGit(root, "show", ":beta.txt")).toBe("staged beta\n");
  });

  test("hunk navigation makes Space mutate only the active hunk on either stream side", async () => {
    const original = Array.from({ length: 40 }, (_, index) => `line ${index + 1}\n`).join("");
    const root = await createReview({
      prepare: (root) => {
        writeFileSync(join(root, "alpha.txt"), original);
        runTestGit(root, "add", "alpha.txt");
        runTestGit(root, "commit", "--only", "-m", "Long alpha", "--", "alpha.txt");
        writeFileSync(
          join(root, "alpha.txt"),
          original.replace("line 2\n", "first change\n").replace("line 35\n", "second change\n"),
        );
      },
    });
    await press("]");
    await press(" ");
    await waitForReview(() => setup!.captureCharFrame().includes("Staged hunk 2 in alpha.txt."));
    expect(runTestGit(root, "show", ":alpha.txt")).toBe(
      original.replace("line 35\n", "second change\n"),
    );
    await press("\t");
    await waitForReview(() => setup!.captureCharFrame().includes("second change"));
    await press("[");
    await press(" ");
    await waitForReview(() => setup!.captureCharFrame().includes("Unstaged hunk 1 in alpha.txt."));
    expect(runTestGit(root, "show", ":alpha.txt")).toBe(original);
    expect(runTestGit(root, "show", ":beta.txt")).toBe("staged beta\n");
  });

  test("a recreated rename source selects its own unstaged file before Space", async () => {
    const root = await createReview({
      staged: true,
      prepare: (root) => {
        runTestGit(root, "restore", "alpha.txt");
        renameSync(join(root, "alpha.txt"), join(root, "renamed.txt"));
        runTestGit(root, "add", "-A");
        writeFileSync(join(root, "alpha.txt"), "recreated source\n");
      },
    });
    await press(".");
    await press(".");
    await waitForReview(() => setup!.captureCharFrame().includes("recreated source"));
    await press(" ");
    await waitForReview(() => setup!.captureCharFrame().includes("Staged alpha.txt."));
    expect(runTestGit(root, "show", ":alpha.txt")).toBe("recreated source\n");
    expect(runTestGit(root, "show", ":renamed.txt")).toBe("one\ntwo\nthree\n");
  });

  test("a file becoming clean releases selection for the next changed file", async () => {
    const root = await createReview({
      prepare: (root) => {
        runTestGit(root, "add", "alpha.txt");
        writeFileSync(join(root, "alpha.txt"), runTestGit(root, "show", "HEAD:alpha.txt"));
      },
    });
    await press(" ");
    await waitForReview(() => setup!.captureCharFrame().includes("Staged alpha.txt."));
    await press(".");
    await press(" ");
    await waitForReview(() => setup!.captureCharFrame().includes("Unstaged beta.txt."));
    expect(runTestGit(root, "diff", "--cached")).toBe("");
  });

  test("repeated Space cannot replay a pending action and graceful quit waits for the write", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let quit = false;
    const root = await createReview({
      beforeStage: async () => {
        calls++;
        await gate;
      },
      onQuit: () => {
        quit = true;
      },
    });
    try {
      await press("  ");
      await waitForReview(() => calls === 1);
      await press("q");
      expect(quit).toBe(false);
      expect(calls).toBe(1);
    } finally {
      release();
    }
    await waitForReview(() => quit);
    expect(runTestGit(root, "show", ":alpha.txt")).toContain("changed alpha");
    expect(calls).toBe(1);
  });
  test("sidebar includes both sides and Space stages then unstages the same file", async () => {
    const root = await createReview();
    expect(setup!.captureCharFrame()).toContain("beta.txt");
    await press(" ");
    await waitForReview(() => setup!.captureCharFrame().includes("Staged alpha.txt."));
    expect(runTestGit(root, "show", ":alpha.txt")).toContain("changed alpha");
    expect(setup!.captureCharFrame()).toContain("Staged (2)");
    await press(" ");
    await waitForReview(() => setup!.captureCharFrame().includes("Unstaged alpha.txt."));
    expect(runTestGit(root, "diff", "--cached", "--name-only").trim()).toBe("beta.txt");
    expect(setup!.captureCharFrame()).toContain("alpha.txt");
    expect(setup!.captureCharFrame()).toContain("beta.txt");
  });

  test("Tab changes the full stream and does not mutate Git", async () => {
    const root = await createReview();
    const before = runTestGit(root, "status", "--porcelain");
    await press("\t");
    await waitForReview(() => setup!.captureCharFrame().includes("staged beta"));
    expect(runTestGit(root, "status", "--porcelain")).toBe(before);
    expect(setup!.captureCharFrame()).toContain("alpha.txt");
  });

  test("navigation to a staged-only sidebar file switches sides before Space unstages it", async () => {
    const root = await createReview();
    await press(".");
    await waitForReview(() => setup!.captureCharFrame().includes("staged beta"));
    await press(" ");
    await waitForReview(() => setup!.captureCharFrame().includes("Unstaged beta.txt."));
    expect(runTestGit(root, "diff", "--cached")).toBe("");
  });
});
