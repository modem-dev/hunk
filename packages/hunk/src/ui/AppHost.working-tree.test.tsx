import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
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
  resolveEditorLine,
  onQuit,
  prepare,
  staged = false,
  width = 150,
}: {
  beforeStage?: () => Promise<void>;
  resolveEditorLine?: () => Promise<number>;
  onQuit?: () => void;
  prepare?: (root: string) => void;
  staged?: boolean;
  width?: number;
} = {}) {
  const root = createTestWorkingTreeRepo();
  roots.push(root);
  writeFileSync(join(root, "alpha.txt"), "one\nchanged alpha\nthree\n");
  writeFileSync(join(root, "beta.txt"), "staged beta\n");
  runTestGit(root, "add", "beta.txt");
  prepare?.(root);
  const catalog = getBundledVcsCatalog();
  const vcsCatalog =
    beforeStage || resolveEditorLine
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
                  resolveWorkingTreeLine: resolveEditorLine ?? workingTree.resolveWorkingTreeLine,
                  stageFile: async (...args: Parameters<typeof stageFile>) => {
                    await beforeStage?.();
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
    width,
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
  test("a retired editor lookup neither blocks nor overwrites a reloaded review", async () => {
    let rejectRetired!: (error: Error) => void;
    const retired = new Promise<number>((_, reject) => {
      rejectRetired = reject;
    });
    let lookups = 0;
    const originalEditor = process.env.EDITOR;
    const originalSpawn = Bun.spawnSync;
    const editorCalls: string[][] = [];
    const spawn = spyOn(Bun, "spawnSync");
    spawn.mockImplementation(((command, options) => {
      if (Array.isArray(command) && command[0] === "nvim") {
        editorCalls.push(command);
        return { exitCode: 0 };
      }
      return originalSpawn(command, options);
    }) as typeof Bun.spawnSync);
    process.env.EDITOR = "nvim";
    try {
      const root = await createReview({
        staged: true,
        prepare: (root) => runTestGit(root, "add", "alpha.txt"),
        resolveEditorLine: () => (++lookups === 1 ? retired : Promise.resolve(2)),
      });
      await press("e");
      expect(lookups).toBe(1);
      writeFileSync(join(root, "alpha.txt"), "replacement generation\n");
      runTestGit(root, "add", "alpha.txt");
      await press("r");
      await waitForReview(() => setup!.captureCharFrame().includes("replacement generation"));
      await press("e");
      await waitForReview(() => editorCalls.length === 1);
      // Reload restores the bundled catalog; its real resolver must not wait for the old one.
      expect(lookups).toBe(1);
      expect(editorCalls[0]).toEqual(["nvim", "+1", join(root, "alpha.txt")]);
      await act(async () => {
        rejectRetired(new Error("retired lookup failure"));
        await Bun.sleep(0);
      });
      expect(setup!.captureCharFrame()).not.toContain("retired lookup failure");
      expect(editorCalls).toHaveLength(1);
    } finally {
      spawn.mockRestore();
      if (originalEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = originalEditor;
    }
  });

  test("an external edit after discard consent is shown refuses the stale target", async () => {
    const root = await createReview();
    const fileY = setup!
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => {
        const parts = line.split("│");
        const sidebar = parts.length >= 3 ? (parts[1] ?? "") : (parts[0] ?? "");
        return sidebar.includes("alpha.txt");
      });
    expect(fileY).toBeGreaterThan(0);
    // Discard is scoped to the focused files pane.
    await act(async () => {
      await setup!.mockMouse.click(6, fileY);
    });
    await press("d");
    await waitForReview(() => setup!.captureCharFrame().includes("Discard changes"));
    writeFileSync(join(root, "alpha.txt"), "changed after prompt\n");
    await press("x");
    await waitForReview(() => setup!.captureCharFrame().includes("changed since"));
    expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("changed after prompt\n");
    expect(runTestGit(root, "show", ":beta.txt")).toBe("staged beta\n");
  });

  test("Space keeps the file action when hunk staging is not available", async () => {
    const root = await createReview({
      prepare: (root) => {
        writeFileSync(join(root, "alpha.txt"), "one\ntwo\nthree\n");
        writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 0, 2, 255]));
        runTestGit(root, "add", "--", "blob.bin");
        runTestGit(root, "commit", "--only", "-m", "binary", "--", "blob.bin");
        writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 0, 3, 255]));
      },
    });
    await waitForReview(() => setup!.captureCharFrame().includes("blob.bin"));
    await press("]");
    await waitForReview(() => setup!.captureCharFrame().includes("Stage file"));
    expect(setup!.captureCharFrame()).not.toContain("Stage hunk");
    await press(" ");
    await waitForReview(() => setup!.captureCharFrame().includes("Staged blob.bin."));
    expect(runTestGit(root, "status", "--porcelain", "--", "blob.bin").trim()).toBe("M  blob.bin");
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

  test("unstaged review keeps +/- stats on staged-only files in the sidebar", async () => {
    await createReview();
    const sidebar = setup!
      .captureCharFrame()
      .split("\n")
      .map((line) => {
        const parts = line.split("│");
        return parts.length >= 3 ? (parts[1] ?? "") : "";
      })
      .join("\n");
    expect(sidebar).toMatch(/alpha\.txt.*\+/);
    expect(sidebar).toMatch(/beta\.txt.*\+1/);
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

  test("selecting a mixed folder stays on the current side and keeps its line stats", async () => {
    await createReview({
      prepare: (nextRoot) => {
        mkdirSync(join(nextRoot, "docs"), { recursive: true });
        writeFileSync(join(nextRoot, "docs", "aaa-staged.md"), "staged docs\n");
        writeFileSync(join(nextRoot, "docs", "zzz-unstaged.md"), "unstaged docs\n");
        runTestGit(nextRoot, "add", "docs/aaa-staged.md");
      },
    });
    await waitForReview(() => setup!.captureCharFrame().includes("zzz-unstaged.md"));
    const folderY = setup!
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => {
        const parts = line.split("│");
        const sidebar = parts.length >= 3 ? (parts[1] ?? "") : (parts[0] ?? "");
        return sidebar.includes("docs/") && !sidebar.includes(".md");
      });
    expect(folderY).toBeGreaterThan(0);
    await act(async () => {
      await setup!.mockMouse.click(6, folderY);
    });
    await waitForReview(() => {
      const frame = setup!.captureCharFrame();
      return frame.includes("Unstaged (") && frame.includes("zzz-unstaged.md");
    });
    const frame = setup!.captureCharFrame();
    expect(frame).toContain("Unstaged (");
    expect(frame).toContain("Stage folder");
    expect(frame).toContain("zzz-unstaged.md");
    expect(frame).toContain("unstaged docs");
    expect(frame).not.toContain("aaa-staged.md");
    expect(frame).toMatch(/\+1/);
    expect(frame).toContain("alpha.txt");
  });

  test("Space on a compact folder stages only the files listed under that header", async () => {
    const root = await createReview({
      prepare: (nextRoot) => {
        mkdirSync(join(nextRoot, "src", "nested"), { recursive: true });
        writeFileSync(join(nextRoot, "src", "one.ts"), "one\n");
        writeFileSync(join(nextRoot, "src", "nested", "two.ts"), "two\n");
      },
    });
    await waitForReview(() => setup!.captureCharFrame().includes("one.ts"));
    const folderY = setup!
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => {
        const parts = line.split("│");
        const sidebar = parts.length >= 3 ? (parts[1] ?? "") : (parts[0] ?? "");
        return sidebar.includes("src/") && !sidebar.includes("nested") && !sidebar.includes(".ts");
      });
    expect(folderY).toBeGreaterThan(0);
    await act(async () => {
      await setup!.mockMouse.click(6, folderY);
    });
    await press(" ");
    await waitForReview(() => setup!.captureCharFrame().includes("Staged src/one.ts."));
    expect(runTestGit(root, "status", "--porcelain", "--", "src/one.ts").trim()).toBe(
      "A  src/one.ts",
    );
    expect(runTestGit(root, "status", "--porcelain", "--", "src/nested/two.ts").trim()).toBe(
      "?? src/nested/two.ts",
    );
    expect(runTestGit(root, "status", "--porcelain", "--", "alpha.txt").trim()).toMatch(/^\s*M/);
  });

  test("Space on a tree folder stages nested files shown under that row", async () => {
    const root = await createReview({
      width: 220,
      prepare: (nextRoot) => {
        mkdirSync(join(nextRoot, "src", "nested"), { recursive: true });
        writeFileSync(join(nextRoot, "src", "one.ts"), "one\n");
        writeFileSync(join(nextRoot, "src", "nested", "two.ts"), "two\n");
      },
    });
    await waitForReview(() => setup!.captureCharFrame().includes("one.ts"));
    const folderY = setup!
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => {
        const parts = line.split("│");
        const sidebar = parts.length >= 3 ? (parts[1] ?? "") : (parts[0] ?? "");
        return sidebar.includes("src/") && !sidebar.includes("nested") && !sidebar.includes(".ts");
      });
    expect(folderY).toBeGreaterThan(0);
    await act(async () => {
      await setup!.mockMouse.click(6, folderY);
    });
    await press(" ");
    await waitForReview(() => setup!.captureCharFrame().includes("Staged 2 files in src/."));
    expect(runTestGit(root, "status", "--porcelain", "--", "src/one.ts").trim()).toBe(
      "A  src/one.ts",
    );
    expect(runTestGit(root, "status", "--porcelain", "--", "src/nested/two.ts").trim()).toBe(
      "A  src/nested/two.ts",
    );
    expect(runTestGit(root, "status", "--porcelain", "--", "alpha.txt").trim()).toMatch(/^\s*M/);
  });
});
