import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { removeTestDirectory } from "../../test/helpers/filesystem";
import { loadAppBootstrap } from "../core/loaders";
import type { AppBootstrap, CliInput } from "../core/types";
import { loadStartupExtensions } from "../extensions/startup";
import { AppHost } from "./AppHost";

/**
 * `ctx.workspace`, driven through the real app: a fixture extension reads a
 * reviewed file's document and asks to replace it, Hunk raises the confirm the
 * user actually answers, and the bytes on disk are what the answer decided. The
 * policy behind the refusals is unit-tested in `lib/extensionWorkspace.test.ts`;
 * only the whole stack can show the real loader-attached source behind a read,
 * the prompt, the write, and the reload.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTestDirectory(dir)));
});

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Run one portable Git fixture command without inheriting shell behavior. */
function runGit(repo: string, args: string[]) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

/** Create a Git checkout with one committed file carrying a working-tree change. */
function createTestRepo(prefix: string) {
  const repo = createTempDir(prefix);
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "test@test"]);
  runGit(repo, ["config", "user.name", "test"]);
  runGit(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "alpha.txt"), "one\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  writeFileSync(join(repo, "alpha.txt"), "one\ntwo\n");
  return repo;
}

/**
 * Create a Git checkout whose only reviewed change is a symlink pointing at a
 * file outside it. Git treats a link to a file as an ordinary reviewable entry,
 * so this is a changeset a real review can hand `ctx.workspace` — and the one
 * shape where a repo-relative path and the bytes a write would replace are not
 * in the same repository.
 */
function createTestRepoLinkingOutside(prefix: string) {
  const repo = createTempDir(prefix);
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "test@test"]);
  runGit(repo, ["config", "user.name", "test"]);
  runGit(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "alpha.txt"), "one\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);

  const outside = createTempDir(`${prefix}outside-`);
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, "secret\n");
  symlinkSync(secret, join(repo, "linked.txt"));
  return { repo, secret };
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

/**
 * Write the fixture whose `y` command reads both document sides of the
 * selection, plus a file id no review carries, and logs each answer.
 */
function writeReadFixture(extPath: string, logPath: string) {
  writeFileSync(
    extPath,
    `import { appendFileSync } from "node:fs";\n` +
      `export default function (hunk) {\n` +
      `  hunk.registerCommand({ id: "read", title: "Read", key: "y" }, async (ctx) => {\n` +
      `    const file = ctx.selection.file;\n` +
      `    if (!file) return;\n` +
      `    const log = (line) => appendFileSync(${JSON.stringify(logPath)}, line + "\\n");\n` +
      `    log("new " + JSON.stringify(await ctx.workspace.readDocument(file.id, "new")));\n` +
      `    log("old " + JSON.stringify(await ctx.workspace.readDocument(file.id, "old")));\n` +
      `    log("unknown " + JSON.stringify(await ctx.workspace.readDocument("no-such-file", "new")));\n` +
      `    log("can " + String(ctx.workspace.canWriteDocument(file.id)));\n` +
      `  });\n` +
      `}\n`,
  );
}

/**
 * Write the fixture whose `y` command runs the pairing the API exists for:
 * read the new side, transform the text, write the result back.
 */
function writeReadWriteFixture(extPath: string, logPath: string) {
  writeFileSync(
    extPath,
    `import { appendFileSync } from "node:fs";\n` +
      `export default function (hunk) {\n` +
      `  hunk.registerCommand({ id: "shout", title: "Shout", key: "y" }, async (ctx) => {\n` +
      `    const file = ctx.selection.file;\n` +
      `    if (!file) return;\n` +
      `    const log = (line) => appendFileSync(${JSON.stringify(logPath)}, line + "\\n");\n` +
      `    const current = await ctx.workspace.readDocument(file.id, "new");\n` +
      `    if (current === null) { log("read null"); return; }\n` +
      `    const result = await ctx.workspace.writeDocument({\n` +
      `      fileId: file.id,\n` +
      `      text: current.toUpperCase(),\n` +
      `    });\n` +
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

describe("extension workspace reads", () => {
  test("reads the working tree's current document for a working-tree review", async () => {
    const repo = createTestRepo("hunk-ext-read-worktree-");
    const extDir = createTempDir("hunk-ext-read-worktree-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeReadFixture(extPath, logPath);

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
        () => readProbeLog(logPath).length >= 4,
        "the handler to log every read",
      );

      const log = readProbeLog(logPath);
      // The new side is the file on disk right now; the old side is what the
      // review is comparing it against.
      expect(log).toContain(`new ${JSON.stringify("one\ntwo\n")}`);
      expect(log).toContain(`old ${JSON.stringify("one\n")}`);
      // A read never asks, so nothing was raised on the way to the answer.
      expect(setup.captureCharFrame()).not.toContain("Write alpha.txt?");
    });
  });

  test("reads a revision's document in a review that refuses writes", async () => {
    const repo = createTestRepo("hunk-ext-read-show-");
    const extDir = createTempDir("hunk-ext-read-show-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeReadFixture(extPath, logPath);

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
        () => readProbeLog(logPath).length >= 4,
        "the handler to log every read",
      );

      const log = readProbeLog(logPath);
      // Reads are available where writes are not, and they answer with the
      // reviewed revision rather than the working tree that has moved past it.
      expect(log).toContain("can false");
      expect(log).toContain(`new ${JSON.stringify("one\n")}`);
      // The commit added the file, so it has no old side to read.
      expect(log).toContain("old null");
    });
  });

  test("resolves null for a file id no review carries", async () => {
    const repo = createTestRepo("hunk-ext-read-unknown-");
    const extDir = createTempDir("hunk-ext-read-unknown-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeReadFixture(extPath, logPath);

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
        () => readProbeLog(logPath).length >= 4,
        "the handler to log every read",
      );

      // An unknown id is a probe with an answer, not a thrown handler failure.
      expect(readProbeLog(logPath)).toContain("unknown null");
    });
  });

  test("reads a document, transforms it, and writes it back", async () => {
    const repo = createTestRepo("hunk-ext-read-write-");
    const extDir = createTempDir("hunk-ext-read-write-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeReadWriteFixture(extPath, logPath);

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
        await setup.mockInput.pressEnter();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes('result {"ok":true}'),
        "the handler to resolve a successful write",
      );
      // The written text is the read text transformed, so the read reached the
      // whole document rather than the patch the review was built from.
      expect(readFileSync(join(repo, "alpha.txt"), "utf8")).toBe("ONE\nTWO\n");
    });
  });
});

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

  test("refuses when the reviewed file disappears while consent is pending", async () => {
    const repo = createTestRepo("hunk-ext-write-disappears-");
    const extDir = createTempDir("hunk-ext-write-disappears-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    const targetPath = join(repo, "alpha.txt");
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

      unlinkSync(targetPath);
      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).some((line) => line.includes('"reason":"unavailable"')),
        "the changed target to be refused",
      );

      expect(existsSync(targetPath)).toBe(false);
      expect(readProbeLog(logPath).join("\n")).toContain("no longer in the working tree");
    });
  });

  test.skipIf(process.platform === "win32")(
    "refuses when the reviewed file becomes a symlink while consent is pending",
    async () => {
      const repo = createTestRepo("hunk-ext-write-link-swap-");
      const extDir = createTempDir("hunk-ext-write-link-swap-ext-");
      const outside = createTempDir("hunk-ext-write-link-swap-outside-");
      const logPath = join(extDir, "probe.log");
      const extPath = join(extDir, "ext.ts");
      const targetPath = join(repo, "alpha.txt");
      const secretPath = join(outside, "secret.txt");
      writeFileSync(secretPath, "secret\n");
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

        unlinkSync(targetPath);
        symlinkSync(secretPath, targetPath);
        await act(async () => {
          await setup.mockInput.pressEnter();
        });
        await flushUntil(
          setup,
          () => readProbeLog(logPath).some((line) => line.includes('"reason":"unavailable"')),
          "the changed target to be refused",
        );

        expect(readProbeLog(logPath).join("\n")).toContain("is a symlink");
        expect(readFileSync(secretPath, "utf8")).toBe("secret\n");
      });
    },
  );

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

  // Creating symlinks needs Developer Mode or elevation on Windows; the refusal
  // itself is portable, only this fixture is not.
  test.skipIf(process.platform === "win32")(
    "a reviewed symlink refuses the write without asking the user",
    async () => {
      const { repo, secret } = createTestRepoLinkingOutside("hunk-ext-write-symlink-");
      const extDir = createTempDir("hunk-ext-write-symlink-ext-");
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
          () => setup.captureCharFrame().includes("linked.txt"),
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
        expect(log.join("\n")).toContain("is a symlink");
        // The probe skips the filesystem and says yes; the write is the half
        // that looks, and it refuses before anyone is asked to consent to a
        // prompt that would have named only `linked.txt`.
        expect(log).toContain("can true");
        expect(setup.captureCharFrame()).not.toContain("Write linked.txt?");
        // Nothing followed the link out of the repository.
        expect(readFileSync(secret, "utf8")).toBe("secret\n");
      });
    },
  );

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
