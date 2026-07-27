import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { loadAppBootstrap } from "../core/loaders";
import type { AppBootstrap } from "../core/types";
import { loadStartupExtensions } from "../extensions/startup";
import { AppHost } from "./AppHost";

/**
 * Extension-contributed sidebar views, mounted through the real load path: a
 * fixture file on disk, dynamically imported, its `react` served by the host
 * runtime module shim. That import route is the point — hooks inside the
 * fixture only work if the component landed on the host's React instance.
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

/** Create a Git checkout with two committed files carrying working-tree changes. */
function createTestRepo(prefix: string) {
  const repo = createTempDir(prefix);
  execSync("git init && git config user.email test@test && git config user.name test", {
    cwd: repo,
    stdio: "ignore",
  });
  writeFileSync(join(repo, "alpha.txt"), "one\n");
  writeFileSync(join(repo, "beta.txt"), "one\n");
  execSync("git add . && git commit -m init", { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "alpha.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "beta.txt"), "one\ntwo\n");
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

/** Mount one AppHost at a sidebar-wide size, run the body, and tear down. */
async function withAppHost(
  bootstrap: AppBootstrap,
  body: (setup: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
) {
  // The sidebar only renders on a "full" viewport, which starts at 220 columns.
  const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 240, height: 30 });

  try {
    await flush(setup);
    await body(setup);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

describe("extension sidebar views", () => {
  test("renders a custom component with live props, hooks, and working actions", async () => {
    const repo = createTestRepo("hunk-ext-sidebar-");
    // Outside the repo, so the fixture and its log never join the review as
    // untracked files and the visible file count stays the two changed files.
    const extDir = createTempDir("hunk-ext-sidebar-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    // `useState`/`useEffect` prove the fixture's `react` is the host instance:
    // hooks on a second React copy would throw an invalid-hook-call error and
    // trip the fallback instead of rendering. The effect drives `selectFile`,
    // whose result comes back through the ordinary `selection_changed` event.
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `import { createElement, useEffect, useState } from "react";\n` +
        `export default function (hunk) {\n` +
        `  hunk.on("selection_changed", (payload) => {\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "selection " + payload.fileId + "\\n");\n` +
        `  });\n` +
        `  hunk.registerSidebarView({\n` +
        `    id: "probe",\n` +
        `    component: (props) => {\n` +
        `      const [mounted] = useState(true);\n` +
        `      const target = props.files[1];\n` +
        `      useEffect(() => {\n` +
        `        if (target) {\n` +
        `          appendFileSync(${JSON.stringify(logPath)}, "target " + target.id + "\\n");\n` +
        `          props.actions.selectFile(target.id);\n` +
        `        }\n` +
        `      }, [target && target.id]);\n` +
        `      return createElement("text", {\n` +
        `        content: "EXTSIDEBAR files=" + props.files.length + " mounted=" + mounted,\n` +
        `        style: { fg: props.theme.text, bg: props.theme.panel },\n` +
        `      });\n` +
        `    },\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("EXTSIDEBAR files=2 mounted=true"),
        "the extension sidebar to render with its props",
      );

      // The effect-driven action lands as a real selection change: the id the
      // component targeted is the id the lifecycle event reports.
      await flushUntil(
        setup,
        () => {
          const log = readProbeLog(logPath);
          const target = log.find((line) => line.startsWith("target "))?.slice("target ".length);
          return target !== undefined && log.includes(`selection ${target}`);
        },
        "the sidebar action to drive selection_changed",
      );
    });
  });

  test("falls back to the built-in sidebar when the component throws", async () => {
    const repo = createTestRepo("hunk-ext-sidebar-broken-");
    const extPath = join(createTempDir("hunk-ext-sidebar-broken-ext-"), "ext.ts");
    writeFileSync(
      extPath,
      `export default function (hunk) {\n` +
        `  hunk.registerSidebarView({\n` +
        `    id: "broken",\n` +
        `    component: () => {\n` +
        `      throw new Error("sidebar exploded");\n` +
        `    },\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      // The failure surfaces as a toast naming the extension, and the built-in
      // sidebar takes over — its file rows are on screen, the session is not.
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("using the built-in sidebar"),
        "the render failure toast to appear",
      );
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("alpha.txt"),
        "the built-in sidebar fallback to render",
      );
    });
  });
});
