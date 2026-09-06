import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { removeTestDirectory } from "../../../../test/helpers/filesystem";
import { loadAppBootstrap as loadCoreAppBootstrap } from "../core/changeset/loaders";

import type { AppBootstrap } from "../app/types";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import { loadStartupExtensions } from "../extensions/startup";
import { AppHost } from "./AppHost";

/** Specialize the core loader result with extension state assigned by these tests. */
function loadAppBootstrap(...args: Parameters<typeof loadCoreAppBootstrap>): Promise<AppBootstrap> {
  const [input, options] = args;
  return loadCoreAppBootstrap(input, {
    vcsCatalog: getBundledVcsCatalog(),
    ...options,
  }) as Promise<AppBootstrap>;
}

/**
 * `ctx.navigation`, driven through the real app: a fixture extension's command
 * jumps the review stream, and the `selection_changed` event that comes back is
 * the proof the navigation ran through the same controller as a sidebar click.
 * The guard semantics themselves are unit-tested in `lib/extensionNavigation.test.ts`.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await removeTestDirectory(dir);
  }
});

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Create a Git checkout with three committed files carrying working-tree changes. */
function createTestRepo(prefix: string) {
  const repo = createTempDir(prefix);
  execSync("git init && git config user.email test@test && git config user.name test", {
    cwd: repo,
    stdio: "ignore",
  });
  writeFileSync(join(repo, "alpha.txt"), "one\n");
  writeFileSync(join(repo, "beta.txt"), "one\n");
  writeFileSync(join(repo, "gamma.txt"), "one\n");
  execSync("git add . && git commit -m init", { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "alpha.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "beta.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "gamma.txt"), "one\ntwo\n");
  return repo;
}

function readProbeLog(logPath: string) {
  try {
    return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Render frames until a condition holds, and fail loudly when it never does. */
async function flushUntil(
  setup: Awaited<ReturnType<typeof testRender>>,
  predicate: () => boolean,
  description: string,
  timeoutMs = 4_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}.`);
    }

    await flush(setup);
    await act(async () => {
      await Bun.sleep(20);
    });
  }
}

/** Launch a bootstrap whose extensions come from one `--extension` fixture path. */
async function launchWithExtension(repo: string, extPath: string): Promise<AppBootstrap> {
  const bootstrap = await loadAppBootstrap(
    { kind: "vcs", staged: false, options: { mode: "stack", extensionPaths: [extPath] } },
    { cwd: repo },
  );
  bootstrap.extensions = await loadStartupExtensions({
    extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
    cwd: repo,
    cliExtensionPaths: [extPath],
  });
  expect(bootstrap.extensions.issues).toEqual([]);
  return bootstrap;
}

/** Mount one AppHost, run the body, and tear down. */
async function withAppHost(
  bootstrap: AppBootstrap,
  body: (setup: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
) {
  const setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={() => {}} />, {
    width: 140,
    height: 30,
  });

  try {
    await flush(setup);
    await body(setup);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

describe("extension command navigation", () => {
  test("public command controls execute counted navigation and refuse extension commands", async () => {
    const repo = createTestRepo("hunk-ext-command-controls-");
    const extDir = createTempDir("hunk-ext-command-controls-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `let fileIds = [];\n` +
        `export default function (hunk) {\n` +
        `  hunk.on("changeset_loaded", ({ changeset }) => {\n` +
        `    fileIds = changeset.files.map((file) => file.id);\n` +
        `  });\n` +
        `  hunk.on("selection_changed", ({ fileId, hunkIndex }) => {\n` +
        `    const label = fileId === fileIds[2] ? "third" : "other";\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "selected " + label + " " + hunkIndex + "\\n");\n` +
        `  });\n` +
        `  hunk.registerCommand({ id: "probe", title: "Probe", key: "y" }, (ctx) => {\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "enabled " + ctx.commands.isEnabled("hunk.review.nextHunk") + "\\n");\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "own " + ctx.commands.execute("ext.probe") + "\\n");\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "move " + ctx.commands.execute("hunk.review.nextHunk", { count: 2 }) + "\\n");\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "align " + ctx.commands.execute("hunk.review.alignCurrentLineCenter") + "\\n");\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("alpha.txt"),
        "the review to render",
      );
      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("selected third 0"),
        "the counted command to land directly on the third hunk",
      );

      expect(readProbeLog(logPath)).toEqual(
        expect.arrayContaining(["enabled true", "align true", "own false", "move true"]),
      );
    });
  });

  test("a command handler jumps the review stream through ctx.navigation", async () => {
    const repo = createTestRepo("hunk-ext-nav-jump-");
    // Outside the repo, so the fixture and its log never join the review.
    const extDir = createTempDir("hunk-ext-nav-jump-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `let fileIds = [];\n` +
        `export default function (hunk) {\n` +
        `  hunk.on("changeset_loaded", ({ changeset }) => {\n` +
        `    fileIds = changeset.files.map((file) => file.id);\n` +
        `  });\n` +
        `  hunk.on("selection_changed", ({ fileId, hunkIndex }) => {\n` +
        `    const label = fileId === fileIds[1] ? "second" : "other";\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "selected " + label + " " + hunkIndex + "\\n");\n` +
        `  });\n` +
        // An out-of-range index on purpose: the guard clamps it into the
        // file's real hunk range before it reaches the review controller.
        `  hunk.registerCommand({ id: "jump", title: "Jump", key: "y" }, (ctx) => {\n` +
        `    ctx.navigation.selectHunk(fileIds[1], 99);\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("beta.txt"),
        "the review to render",
      );

      await act(async () => {
        await setup.mockInput.typeText("y");
      });

      // `selection_changed` firing for the second file is the whole proof:
      // the command's jump ran through the same review controller a sidebar
      // row click uses, debounce and all, with the index clamped to 0.
      await flushUntil(
        setup,
        () => readProbeLog(logPath).some((line) => line === "selected second 0"),
        "the selection to land on the second file's only hunk",
      );
    });
  });

  test("navigation to a file the stream cannot show warns instead of jumping", async () => {
    const repo = createTestRepo("hunk-ext-nav-unknown-");
    const extDir = createTempDir("hunk-ext-nav-unknown-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `export default function (hunk) {\n` +
        `  hunk.on("selection_changed", ({ fileId }) => {\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "selected " + fileId + "\\n");\n` +
        `  });\n` +
        `  hunk.registerCommand({ id: "bogus", title: "Bogus", key: "y" }, (ctx) => {\n` +
        `    ctx.navigation.selectFile("no-such-file");\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "handler-finished\\n");\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("alpha.txt"),
        "the review to render",
      );

      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("handler-finished"),
        "the command handler to finish",
      );

      // The refusal surfaces as a toast naming the extension, and the
      // selection never moved to the phantom id.
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes('targeted unknown file id "no-such-file"'),
        "the warning toast to render",
      );
      expect(readProbeLog(logPath)).not.toContain("selected no-such-file");
    });
  });
});
