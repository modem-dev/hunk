import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { removeTestDirectory } from "../../test/helpers/filesystem";
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
  test("a command key opens an extra sidebar beside the built-in one", async () => {
    const repo = createTestRepo("hunk-ext-sidebar-");
    // Outside the repo, so the fixture and its log never join the review as
    // untracked files and the visible file count stays the two changed files.
    const extDir = createTempDir("hunk-ext-sidebar-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    // `useState`/`useEffect` prove the fixture's `react` is the host instance:
    // hooks on a second React copy would throw an invalid-hook-call error. The
    // view opens through a registered command's key rather than by default —
    // the whole point of the command system — and its effect drives
    // `selectFile`, which comes back through the ordinary `selection_changed`
    // event.
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
        `    title: "Probe",\n` +
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
        `  hunk.registerCommand({ id: "toggle-probe", title: "Toggle probe", key: "y" }, (ctx) => {\n` +
        `    ctx.sidebars.toggle("probe");\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      // Before the command fires, only the built-in file navigation is open.
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("alpha.txt"),
        "the built-in sidebar to render",
      );
      expect(setup.captureCharFrame()).not.toContain("EXTSIDEBAR");

      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => {
          const frame = setup.captureCharFrame();
          return frame.includes("EXTSIDEBAR files=2 mounted=true") && frame.includes("alpha.txt");
        },
        "the command to open the extension sidebar beside the built-in one",
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

      // The same key closes it again.
      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => !setup.captureCharFrame().includes("EXTSIDEBAR"),
        "the command to close the extension sidebar",
      );
    });
  });

  test("injects the user's resolved command bindings into a sidebar view", async () => {
    const repo = createTestRepo("hunk-ext-sidebar-keybindings-");
    const extPath = join(createTempDir("hunk-ext-sidebar-keybindings-ext-"), "ext.ts");
    writeFileSync(
      extPath,
      `import { createElement } from "react";\n` +
        `export default function (hunk) {\n` +
        `  hunk.registerSidebarView({\n` +
        `    id: "keys",\n` +
        `    defaultOpen: true,\n` +
        `    component: (props) => createElement("box", { style: { flexDirection: "column" } },\n` +
        `      createElement("text", {\n` +
        `        content: "EXTKEYS " + props.keybindings.getKeys("hunk.review.nextFile").join(",") +\n` +
        `          " matched=" + props.keybindings.matches({ name: "n", ctrl: true }, "hunk.review.nextFile"),\n` +
        `      }),\n` +
        `      createElement("text", {\n` +
        `        content: "BLOCKED " + (props.keybindings.getKeys("ext.blocked").join(",") || "none"),\n` +
        `      }),\n` +
        `    ),\n` +
        `  });\n` +
        `  hunk.registerCommand({ id: "blocked", title: "Blocked", key: "s" }, () => {});\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    bootstrap.keybindings = { "hunk.review.nextFile": "ctrl+n" };
    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(
        setup,
        () => {
          const frame = setup.captureCharFrame();
          return frame.includes("EXTKEYS ctrl+n matched=true") && frame.includes("BLOCKED none");
        },
        "the sidebar to receive the remapped command manager",
      );
    });
  });

  test("a command handler sees the current review selection", async () => {
    const repo = createTestRepo("hunk-ext-selection-");
    // Outside the repo, so the fixture and its log never join the review as
    // untracked files and shift the selection this test drives.
    const extDir = createTempDir("hunk-ext-selection-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    // The handler reads only `ctx.selection` — no `selection_changed` handler
    // shadowing the selection into module state, which is the whole point.
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `export default function (hunk) {\n` +
        `  hunk.registerCommand({ id: "probe", title: "Probe selection", key: "y" }, (ctx) => {\n` +
        `    const file = ctx.selection.file;\n` +
        `    appendFileSync(\n` +
        `      ${JSON.stringify(logPath)},\n` +
        `      "selection " + (file ? file.path : "none") + "#" + ctx.selection.hunkIndex +\n` +
        `        " frozen=" + Object.isFrozen(file) + "\\n",\n` +
        `    );\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("alpha.txt"),
        "the built-in sidebar to render",
      );

      // The review opens on the first file's first hunk, and the handler sees
      // exactly that without having tracked anything itself.
      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("selection alpha.txt#0 frozen=true"),
        "the command to report the startup selection",
      );

      // `]` moves the review stream to the next hunk, which is the one hunk of
      // the second file; the next run reports the new selection rather than a
      // snapshot captured when the command was registered.
      await act(async () => {
        await setup.mockInput.typeText("]");
      });
      await flush(setup);
      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("selection beta.txt#0 frozen=true"),
        "the command to report the selection after navigating",
      );
    });
  });

  test("opening a view through a command reveals a sidebar area hidden with s", async () => {
    const repo = createTestRepo("hunk-ext-sidebar-reveal-");
    const extPath = join(createTempDir("hunk-ext-sidebar-reveal-ext-"), "ext.ts");
    writeFileSync(
      extPath,
      `import { createElement } from "react";\n` +
        `export default function (hunk) {\n` +
        `  hunk.registerSidebarView({\n` +
        `    id: "probe",\n` +
        `    component: () => createElement("text", { content: "EXTSIDEBAR" }),\n` +
        `  });\n` +
        `  hunk.registerCommand({ id: "open-probe", title: "Open probe", key: "y" }, (ctx) => {\n` +
        `    ctx.sidebars.open("probe");\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      // The sidebar file rows carry the "M <name>" status prefix; the diff
      // pane's own headers do not, so the prefix marks the area's visibility.
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("M alpha.txt"),
        "the built-in sidebar to render",
      );

      await act(async () => {
        await setup.mockInput.typeText("s");
      });
      await flushUntil(
        setup,
        () => !setup.captureCharFrame().includes("M alpha.txt"),
        "the s key to hide the sidebar area",
      );

      // Opening a view is a request to see it: the hidden area reveals again,
      // with the extension pane beside the still-open files pane.
      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => {
          const frame = setup.captureCharFrame();
          return frame.includes("EXTSIDEBAR") && frame.includes("M alpha.txt");
        },
        "the command to reveal the sidebar area with the opened view",
      );
    });
  });

  test("the Extensions menu lists a registered command and runs it", async () => {
    const repo = createTestRepo("hunk-ext-sidebar-menu-");
    const extPath = join(createTempDir("hunk-ext-sidebar-menu-ext-"), "ext.ts");
    // The command ships without a key on purpose: the menu is the only way to
    // reach it, which is exactly the mouse/keyboard parity the menu restores.
    writeFileSync(
      extPath,
      `import { createElement } from "react";\n` +
        `export default function (hunk) {\n` +
        `  hunk.registerSidebarView({\n` +
        `    id: "probe",\n` +
        `    component: () => createElement("text", { content: "EXTSIDEBAR" }),\n` +
        `  });\n` +
        `  hunk.registerCommand({ id: "open-probe", title: "Open the probe pane" }, (ctx) => {\n` +
        `    ctx.sidebars.open("probe");\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("alpha.txt"),
        "the built-in sidebar to render",
      );
      expect(setup.captureCharFrame()).toContain("Extensions");

      // F10 opens the File menu; four steps right lands on Extensions, which
      // only exists because the extension registered a command.
      await act(async () => {
        await setup.mockInput.pressKey("F10");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Toggle files/filter focus"),
        "the menu bar to open",
      );

      for (let step = 0; step < 4; step += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("right");
        });
        await flush(setup);
      }
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Open the probe pane"),
        "the Extensions menu to list the registered command",
      );

      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("EXTSIDEBAR"),
        "the menu entry to run the extension's handler",
      );
    });
  });

  test("a replacesDefault view stands in for the built-in file navigation", async () => {
    const repo = createTestRepo("hunk-ext-sidebar-replace-");
    const extPath = join(createTempDir("hunk-ext-sidebar-replace-ext-"), "ext.ts");
    writeFileSync(
      extPath,
      `import { createElement } from "react";\n` +
        `export default function (hunk) {\n` +
        `  hunk.registerSidebarView({\n` +
        `    id: "replacement",\n` +
        `    replacesDefault: true,\n` +
        `    component: () => createElement("text", { content: "REPLACEMENT SIDEBAR" }),\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("REPLACEMENT SIDEBAR"),
        "the replacement sidebar to render by default",
      );
    });
  });

  test("closes a crashing extra view and restores the built-in sidebar", async () => {
    const repo = createTestRepo("hunk-ext-sidebar-broken-");
    const extPath = join(createTempDir("hunk-ext-sidebar-broken-ext-"), "ext.ts");
    writeFileSync(
      extPath,
      `export default function (hunk) {\n` +
        `  hunk.registerSidebarView({\n` +
        `    id: "broken",\n` +
        `    replacesDefault: true,\n` +
        `    component: () => {\n` +
        `      throw new Error("sidebar exploded");\n` +
        `    },\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      // The failure surfaces as a toast naming the extension; the crashed pane
      // closes and the built-in file navigation reopens in its place.
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("failed rendering"),
        "the render failure toast to appear",
      );
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("alpha.txt"),
        "the built-in sidebar to reopen after the crash",
      );
    });
  });

  test("the documented scrollbox ref contract follows the selection from a fixture sidebar", async () => {
    // Enough changed files that the fixture pane's list overflows its viewport:
    // the last row is only visible if `scrollChildIntoView` actually scrolled.
    const repo = createTempDir("hunk-ext-sidebar-scroll-");
    execSync("git init && git config user.email test@test && git config user.name test", {
      cwd: repo,
      stdio: "ignore",
    });
    const fileCount = 30;
    const names = Array.from(
      { length: fileCount },
      (_, index) => `file-${String(index).padStart(2, "0")}.txt`,
    );
    for (const name of names) {
      writeFileSync(join(repo, name), "one\n");
    }
    execSync("git add . && git commit -m init", { cwd: repo, stdio: "ignore" });
    for (const name of names) {
      writeFileSync(join(repo, name), "one\ntwo\n");
    }

    const extDir = createTempDir("hunk-ext-sidebar-scroll-ext-");
    const logPath = join(extDir, "probe.log");
    // A TSX fixture running the exact recipe docs/extensions.md publishes: a
    // ref on the scrollbox, `id` props on the rows, an effect calling
    // `scrollChildIntoView` when the selection moves, and the documented
    // event subscriptions reporting `scrollTop`/`viewport.height` — the whole
    // committed ref surface, exercised from extension code.
    const extPath = join(extDir, "ext.tsx");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `import { useEffect, useRef } from "react";\n` +
        `import type { ScrollBoxRenderable } from "@opentui/core";\n` +
        `import type { ExtensionSidebarViewProps, HunkExtensionAPI } from "hunkdiff/extension";\n` +
        `\n` +
        `function RefList({ files, selectedFileId, theme }: ExtensionSidebarViewProps) {\n` +
        `  const scrollRef = useRef<ScrollBoxRenderable | null>(null);\n` +
        `\n` +
        `  useEffect(() => {\n` +
        `    const scrollBox = scrollRef.current;\n` +
        `    if (!scrollBox) {\n` +
        `      return;\n` +
        `    }\n` +
        `    const report = () => {\n` +
        `      const top = scrollBox.scrollTop ?? 0;\n` +
        `      const height = scrollBox.viewport.height ?? 0;\n` +
        `      appendFileSync(${JSON.stringify(logPath)}, "geom " + top + " " + height + "\\n");\n` +
        `    };\n` +
        `    scrollBox.verticalScrollBar.on("change", report);\n` +
        `    scrollBox.viewport.on("layout-changed", report);\n` +
        `    scrollBox.viewport.on("resized", report);\n` +
        `    return () => {\n` +
        `      scrollBox.verticalScrollBar.off("change", report);\n` +
        `      scrollBox.viewport.off("layout-changed", report);\n` +
        `      scrollBox.viewport.off("resized", report);\n` +
        `    };\n` +
        `  }, []);\n` +
        `\n` +
        `  useEffect(() => {\n` +
        `    if (selectedFileId !== null) {\n` +
        `      scrollRef.current?.scrollChildIntoView("probe-" + selectedFileId);\n` +
        `    }\n` +
        `  }, [selectedFileId]);\n` +
        `\n` +
        `  return (\n` +
        `    <scrollbox ref={scrollRef} width="100%" height="100%" scrollY={true} focused={false}>\n` +
        `      {files.map((file) => (\n` +
        `        <box key={file.id} id={"probe-" + file.id} style={{ width: "100%", height: 1 }}>\n` +
        `          <text\n` +
        `            content={"ref:" + file.path}\n` +
        `            style={{ fg: file.id === selectedFileId ? theme.accent : theme.text }}\n` +
        `          />\n` +
        `        </box>\n` +
        `      ))}\n` +
        `    </scrollbox>\n` +
        `  );\n` +
        `}\n` +
        `\n` +
        `export default function (hunk: HunkExtensionAPI) {\n` +
        `  hunk.registerSidebarView({\n` +
        `    id: "reflist",\n` +
        `    title: "Ref list",\n` +
        `    placement: "right",\n` +
        `    defaultOpen: true,\n` +
        `    component: RefList,\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("ref:file-00.txt"),
        "the fixture pane to render its first row",
      );
      // The tail of the list starts outside the pane's viewport.
      expect(setup.captureCharFrame()).not.toContain(`ref:file-${fileCount - 1}`);

      // Walk the selection to the last file, one keypress per frame — the
      // review coalesces navigation within a frame, so a single burst would
      // move one file. Each step re-runs the fixture's follow effect, and the
      // final row can only be on screen if `scrollChildIntoView` scrolled.
      for (let step = 0; step < fileCount - 1; step += 1) {
        await act(async () => {
          await setup.mockInput.typeText(".");
        });
        await flush(setup);
      }
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes(`ref:file-${fileCount - 1}`),
        "the fixture pane to follow the selection to the last row",
      );

      // The documented event subscriptions delivered real geometry: layout
      // events reported a nonzero viewport height once the pane laid out, and
      // the scrollbar change event reported a nonzero scrollTop once
      // `scrollChildIntoView` moved the pane — both read through the ref, from
      // extension code, exactly as the guide's bullets promise.
      const geometry = readProbeLog(logPath)
        .filter((line) => line.startsWith("geom "))
        .map((line) => {
          const [, top, height] = line.split(" ");
          return { top: Number(top), height: Number(height) };
        });
      expect(geometry.length).toBeGreaterThan(0);
      expect(Math.max(0, ...geometry.map((entry) => entry.height))).toBeGreaterThan(0);
      expect(Math.max(0, ...geometry.map((entry) => entry.top))).toBeGreaterThan(0);
    });
  });
});
