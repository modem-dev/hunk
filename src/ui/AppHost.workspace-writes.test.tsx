import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { loadAppBootstrap } from "../core/loaders";
import type { AppBootstrap, CliInput } from "../core/types";
import { loadStartupExtensions } from "../extensions/startup";
import { AppHost } from "./AppHost";

/**
 * `ctx.workspace`, driven through the real app: a fixture extension asks to
 * replace a reviewed file, Hunk raises the confirm the user actually answers,
 * and the bytes on disk are what the answer decided. The policy behind the
 * refusals is unit-tested in `lib/extensionWorkspace.test.ts`; only the whole
 * stack can show the prompt, the write, and the reload.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Create a Git checkout with one committed file carrying a working-tree change. */
function createTestRepo(prefix: string) {
  const repo = createTempDir(prefix);
  execSync("git init && git config user.email test@test && git config user.name test", {
    cwd: repo,
    stdio: "ignore",
  });
  writeFileSync(join(repo, "alpha.txt"), "one\n");
  execSync("git add . && git commit -m init", { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "alpha.txt"), "one\ntwo\n");
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
  timeoutMs = 8_000,
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

/**
 * Write the fixture whose `y` command probes the affordance and then asks for a
 * whole-document replacement, logging both answers.
 */
function writeWorkspaceFixture(extPath: string, logPath: string) {
  writeFileSync(
    extPath,
    `import { appendFileSync } from "node:fs";\n` +
      `export default function (hunk) {\n` +
      `  hunk.registerCommand({ id: "rewrite", title: "Rewrite", key: "y" }, async (ctx) => {\n` +
      `    const file = ctx.selection.file;\n` +
      `    if (!file) return;\n` +
      `    const log = (line) => appendFileSync(${JSON.stringify(logPath)}, line + "\\n");\n` +
      `    log("can " + String(ctx.workspace.canWriteDocument(file.id)));\n` +
      `    const result = await ctx.workspace.writeDocument({ fileId: file.id, text: "rewritten\\n" });\n` +
      `    log("result " + JSON.stringify(result));\n` +
      `  });\n` +
      `}\n`,
  );
}

/** Launch a bootstrap for one review input whose extensions come from one fixture path. */
async function launchWithExtension(
  repo: string,
  extPath: string,
  input: CliInput,
): Promise<AppBootstrap> {
  const bootstrap = await loadAppBootstrap(input, { cwd: repo });
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

describe("extension workspace writes", () => {
  test("a confirmed write replaces the reviewed file and reloads the review", async () => {
    const repo = createTestRepo("hunk-ext-write-confirm-");
    // Outside the repo, so the fixture and its log never join the review.
    const extDir = createTempDir("hunk-ext-write-confirm-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeWorkspaceFixture(extPath, logPath);

    const bootstrap = await launchWithExtension(repo, extPath, {
      kind: "vcs",
      staged: false,
      options: { mode: "stack", extensionPaths: [extPath] },
    });
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
        () => setup.captureCharFrame().includes("Write alpha.txt?"),
        "the write confirm to open",
      );

      const frame = setup.captureCharFrame();
      // The prompt says which extension asked and what the write does, so it
      // cannot present itself as Hunk rewriting the file on its own.
      expect(frame).toContain("ext ext");
      expect(frame).toContain("replace this file's contents on disk");
      expect(readProbeLog(logPath)).toContain("can true");
      // Nothing is touched while the question is still open.
      expect(readFileSync(join(repo, "alpha.txt"), "utf8")).toBe("one\ntwo\n");

      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes('result {"ok":true}'),
        "the handler to resolve a successful write",
      );
      expect(readFileSync(join(repo, "alpha.txt"), "utf8")).toBe("rewritten\n");

      // The write reloads the session, so the review catches up with the disk
      // instead of describing the file the extension replaced.
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("rewritten"),
        "the reloaded review to show the written content",
      );
    });
  });

  test("a declined write resolves cancelled and leaves the file alone", async () => {
    const repo = createTestRepo("hunk-ext-write-decline-");
    const extDir = createTempDir("hunk-ext-write-decline-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeWorkspaceFixture(extPath, logPath);

    const bootstrap = await launchWithExtension(repo, extPath, {
      kind: "vcs",
      staged: false,
      options: { mode: "stack", extensionPaths: [extPath] },
    });
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
        () => setup.captureCharFrame().includes("Write alpha.txt?"),
        "the write confirm to open",
      );

      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).some((line) => line.includes('"reason":"cancelled"')),
        "the handler to resolve a cancelled write",
      );
      expect(readFileSync(join(repo, "alpha.txt"), "utf8")).toBe("one\ntwo\n");
    });
  });

  test("a revision review refuses the write without asking the user", async () => {
    const repo = createTestRepo("hunk-ext-write-show-");
    const extDir = createTempDir("hunk-ext-write-show-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeWorkspaceFixture(extPath, logPath);

    const bootstrap = await launchWithExtension(repo, extPath, {
      kind: "show",
      ref: "HEAD",
      options: { mode: "stack", extensionPaths: [extPath] },
    });
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
        () => readProbeLog(logPath).some((line) => line.includes('"reason":"unavailable"')),
        "the handler to resolve an unavailable write",
      );

      const log = readProbeLog(logPath);
      // The affordance and the action agree: a revision show offers neither.
      expect(log).toContain("can false");
      expect(log.join("\n")).toContain("working-tree only");
      // A refusal never reaches the user, so no dialog was ever raised.
      expect(setup.captureCharFrame()).not.toContain("Write alpha.txt?");
      // The working tree still holds the change the review is not about.
      expect(readFileSync(join(repo, "alpha.txt"), "utf8")).toBe("one\ntwo\n");
    });
  });
});
