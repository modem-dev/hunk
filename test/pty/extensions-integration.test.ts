import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPtyHarness, dragMouse, lineIndexOf } from "./harness";

const harness = createPtyHarness();
const REVIEW_TRIAGE_EXTENSION = resolve(
  fileURLToPath(new URL("../../examples/extensions/review-triage", import.meta.url)),
);
const VIM_NAVIGATION_EXTENSION = resolve(
  fileURLToPath(new URL("../../examples/extensions/vim-navigation", import.meta.url)),
);

/** Give PTY-backed startup, reloads, and redraws headroom on slower CI machines. */
setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

/** Read the persisted repo-trust decisions from one isolated config home. */
function readTrustState(configHome: string): Record<string, string> {
  const statePath = join(configHome, "hunk", "state.json");
  if (!existsSync(statePath)) {
    return {};
  }

  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as {
    extensionTrust?: Record<string, string>;
  };
  return parsed.extensionTrust ?? {};
}

/**
 * A repo-local extension whose effect is unmistakable in a snapshot: it renames
 * the changeset and drops one of the two reviewed files.
 */
const TRANSFORM_EXTENSION_SOURCE = `export default function (hunk) {
  hunk.transformChangeset((changeset) => ({
    ...changeset,
    title: "REPO EXTENSION ACTIVE",
    files: changeset.files.filter((file) => !file.path.includes("beta")),
  }));
}
`;

/** A repo-local extension that only speaks through ctx.notify on startup. */
const NOTIFY_EXTENSION_SOURCE = `export default function (hunk) {
  hunk.on("startup", (_payload, ctx) => {
    ctx.notify("hello from the fixture extension");
  });
}
`;

/** An extension that records whether terminal interrupts deliver graceful shutdown. */
const INTERRUPT_SHUTDOWN_EXTENSION_SOURCE = `import { appendFileSync } from "node:fs";
export default function (hunk) {
  hunk.on("startup", (_payload, ctx) => ctx.notify("INTERRUPT FIXTURE READY"));
  hunk.on("shutdown", () => appendFileSync(".hunk-shutdown.log", "shutdown\\n"));
}
`;

/**
 * An extension contributing an extra sidebar opened by a registered command.
 *
 * `useState` matters here: the fixture imports `react` from an ordinary file on
 * disk, so hooks rendering at all proves the host served its own React instance
 * to the extension — on a second React copy the component would throw and the
 * pane would close instead of rendering. The command matters equally: its key
 * dispatches through the same table as Hunk's built-in shortcuts.
 */
const SIDEBAR_EXTENSION_SOURCE = `import { createElement, useState } from "react";
export default function (hunk) {
  hunk.registerSidebarView({
    id: "fixture-sidebar",
    title: "Fixture",
    placement: "right",
    component: (props) => {
      const [label] = useState("EXTSIDEBAR");
      return createElement("text", {
        content: label + " " + props.files.length + " FILES",
        style: { fg: props.theme.text, bg: props.theme.panel },
      });
    },
  });
  hunk.registerCommand({ id: "toggle-fixture", title: "Toggle fixture", key: "y" }, (ctx) => {
    ctx.sidebars.toggle("fixture-sidebar");
  });
}
`;

/** A named files-slot replacement beside an independently controlled pane. */
const FILES_SLOT_EXTENSION_SOURCE = `import { createElement } from "react";
export default function (hunk) {
  hunk.registerPane({
    id: "files-slot",
    placement: "right",
    replaces: "hunk:files",
    component: () => createElement("text", { content: "FILES SLOT RIGHT" }),
  });
  hunk.registerPane({
    id: "aux",
    placement: "left",
    defaultOpen: true,
    component: () => createElement("text", { content: "AUX PANE LEFT" }),
  });
}
`;

/**
 * An extension that asks before acting, so a real terminal exercises the whole
 * dialog path: a registered key opens the modal, Enter resolves the handler's
 * awaited promise, and the answer comes back as a toast.
 */
const FOUR_EDGE_PANE_EXTENSION_SOURCE = `import { createElement } from "react";
export default function (hunk) {
  for (const placement of ["top", "bottom"]) {
    hunk.registerPane({
      id: placement,
      placement,
      defaultOpen: false,
      height: placement === "top"
        ? { preferred: 2, min: 2, max: 5 }
        : { preferred: 2, min: 2, max: 2 },
      component: (props) => createElement("text", {
        content: "PANE " + placement.toUpperCase() + " " + props.width + "x" + props.height,
        style: { fg: props.theme.text, bg: props.theme.panel },
      }),
    });
  }
  hunk.registerCommand({ id: "toggle-edges", title: "Toggle edge panes", key: "y" }, (ctx) => {
    ctx.panes.toggle("top");
    ctx.panes.toggle("bottom");
  });
}
`;

/**
 * An extension marking characters inside the reviewed diff lines.
 *
 * PTY snapshots carry text only, so the visible assertions are that the
 * highlighted review renders unchanged text (paint never moves geometry) and
 * that the refresh controls route: a valid refresh answers with the fixture's
 * own toast, an unknown id with the host's attribution warning. The paint
 * decisions themselves (columns, tones, backgrounds) are unit-tested in
 * src/ui/diff/lineHighlightPaint.test.ts and rowStyle.test.ts.
 */
const LINE_HIGHLIGHT_EXTENSION_SOURCE = `export default function (hunk) {
  hunk.registerLineHighlighter({
    id: "needles",
    highlight({ file }) {
      if (!file.path.includes("alpha")) return null;
      // Mark "alphaValue" on the added line: export const alphaValue = 2;
      return [{ side: "new", line: 1, range: [13, 23], tone: "match" }];
    },
  });
  hunk.registerCommand({ id: "refresh-marks", title: "Refresh marks", key: "f7" }, (ctx) => {
    ctx.highlights.refresh("needles");
    ctx.notify("marks refreshed");
  });
  hunk.registerCommand({ id: "refresh-unknown", title: "Refresh unknown", key: "f8" }, (ctx) => {
    ctx.highlights.refresh("nope");
  });
}
`;

/**
 * A single hunk tall enough that its anchor and its last lines cannot share a
 * viewport, with one unmistakable token near the bottom.
 *
 * Every line differs, so git emits one hunk spanning the whole file — the shape
 * `selectHunk` cannot navigate usefully.
 */
const REVEAL_LINE_TARGET = 111;
const REVEAL_LINE_TOKEN = "REVEALLINETOKEN";
const TALL_HUNK_FILE = {
  path: "tall.ts",
  before: `${Array.from(
    { length: 130 },
    (_, index) => `export const line${String(index + 1).padStart(3, "0")} = ${index + 1};`,
  ).join("\n")}\n`,
  after: `${Array.from({ length: 130 }, (_, index) =>
    index + 1 === REVEAL_LINE_TARGET
      ? `export const needle = "${REVEAL_LINE_TOKEN}";`
      : `export const line${String(index + 1).padStart(3, "0")} = ${index + 1001};`,
  ).join("\n")}\n`,
};

/**
 * An extension that jumps to one exact line of the reviewed file.
 *
 * The second command asks for a line no hunk covers, so the same session shows
 * both halves of the contract: a reachable line scrolls, an unreachable one
 * comes back as a warning naming the extension.
 */
const REVEAL_LINE_EXTENSION_SOURCE = `export default function (hunk) {
  hunk.registerCommand({ id: "jump", title: "Jump to the needle", key: "f7" }, (ctx) => {
    const file = ctx.selection.file;
    if (file) ctx.navigation.revealLine(file.id, "new", ${REVEAL_LINE_TARGET});
  });
  hunk.registerCommand({ id: "jump-nowhere", title: "Jump past the file", key: "f8" }, (ctx) => {
    const file = ctx.selection.file;
    if (file) ctx.navigation.revealLine(file.id, "new", 9001);
  });
}
`;

/**
 * An extension that jumps through pane actions captured at mount.
 *
 * This is the shape the less-search example uses: a keyboard mode cannot
 * navigate, so it leaves the jump for the mounted pane, whose \`actions\` were
 * minted on the pane's first render — before the diff pane had published any
 * measured line cursors — and are documented to stay valid while the pane is
 * mounted. A \`revealLine\` that reads its own stale closure instead of the
 * live cursor list silently degrades this exact call to the hunk fallback.
 */
const REVEAL_LINE_MOUNT_ACTIONS_EXTENSION_SOURCE = `import { createElement } from "react";
let capturedActions = null;
export default function (hunk) {
  hunk.registerPane({
    id: "capture",
    placement: "bottom",
    defaultOpen: true,
    height: { preferred: 1, min: 1, max: 1 },
    component: (props) => {
      if (capturedActions === null) capturedActions = props.actions;
      return createElement("text", { content: "CAPTURE PANE", style: { fg: props.theme.text } });
    },
  });
  hunk.registerCommand({ id: "jump-held", title: "Jump via held actions", key: "f7" }, (ctx) => {
    const file = ctx.selection.file;
    if (file && capturedActions) {
      capturedActions.revealLine(file.id, "new", ${REVEAL_LINE_TARGET});
    }
  });
}
`;

const DIALOG_EXTENSION_SOURCE = `export default function (hunk) {
  hunk.registerCommand({ id: "ask", title: "Ask", key: "y" }, async (ctx) => {
    const proceed = await ctx.dialogs.confirm({
      title: "Reformat the changeset?",
      body: "Nothing is written to disk. This deliberately long explanation wraps across many terminal rows while the actions remain pinned below it.",
      confirmLabel: "reformat",
    });
    ctx.notify(proceed ? "DIALOG ANSWERED YES" : "DIALOG ANSWERED NO");
  });
}
`;

describe("PTY extensions", () => {
  test("trust prompt runs repo extensions after the user trusts the repository", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = harness.createRepoExtensionFixture(TRANSFORM_EXTENSION_SOURCE);
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 140,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      const prompt = await session.waitForText(/Run this repository's extensions\?/, {
        timeout: 20_000,
      });
      expect(prompt).toContain(".hunk/extensions");
      expect(prompt).toContain("Extensions run with your user permissions.");
      // The extension has not run yet, so both files are still under review.
      expect(prompt).toContain("beta.ts");

      await session.press("t");

      const reloaded = await harness.waitForSnapshot(
        session,
        (text) => text.includes("REPO EXTENSION ACTIVE"),
        20_000,
      );
      expect(reloaded).not.toContain("Run this repository's extensions?");
      // The transform filtered beta.ts out of the review stream and the sidebar.
      expect(reloaded).not.toContain("beta.ts");
      expect(reloaded).toContain("alpha.ts");

      expect(readTrustState(configHome)[fixture.dir]).toBe("trusted");
    } finally {
      session.close();
    }
  });

  test("Ctrl-C delivers extension shutdown before the terminal exits", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = harness.createRepoExtensionFixture(INTERRUPT_SHUTDOWN_EXTENSION_SOURCE);
    const shutdownLog = join(fixture.dir, ".hunk-shutdown.log");
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      await session.waitForText(/Run this repository's extensions\?/, { timeout: 20_000 });
      await session.press("t");
      await session.waitForText(/INTERRUPT FIXTURE READY/, { timeout: 20_000 });

      session.sendKey(["ctrl", "c"]);
      const deadline = Date.now() + 5_000;
      while (!existsSync(shutdownLog) && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect(readFileSync(shutdownLog, "utf8")).toBe("shutdown\n");
    } finally {
      session.close();
    }
  });

  test("escape dismisses the trust prompt without persisting a decision", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = harness.createRepoExtensionFixture(TRANSFORM_EXTENSION_SOURCE);
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 140,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      await session.waitForText(/Run this repository's extensions\?/, { timeout: 20_000 });
      await session.press("escape");

      const dismissed = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Run this repository's extensions?"),
        10_000,
      );
      // Review continues untransformed, because the extension never ran.
      expect(dismissed).toContain("beta.ts");
      expect(dismissed).not.toContain("REPO EXTENSION ACTIVE");

      expect(readTrustState(configHome)[fixture.dir]).toBeUndefined();
    } finally {
      session.close();
    }
  });

  test("never records a denial and stops asking on later launches", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = harness.createRepoExtensionFixture(TRANSFORM_EXTENSION_SOURCE);
    const launch = async () =>
      await harness.launchHunk({
        args: ["diff", "--mode", "stack"],
        cwd: fixture.dir,
        cols: 140,
        rows: 24,
        env: { XDG_CONFIG_HOME: configHome },
      });

    const session = await launch();
    try {
      await session.waitForText(/Run this repository's extensions\?/, { timeout: 20_000 });
      await session.press("n");

      const denied = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Run this repository's extensions?"),
        10_000,
      );
      // The extension never ran, so the review is the untransformed one.
      expect(denied).toContain("beta.ts");
      expect(denied).not.toContain("REPO EXTENSION ACTIVE");

      expect(readTrustState(configHome)[fixture.dir]).toBe("denied");
    } finally {
      session.close();
    }

    const relaunched = await launch();
    try {
      const reviewed = await harness.waitForSnapshot(
        relaunched,
        (text) => text.includes("alpha.ts"),
        20_000,
      );
      // A recorded denial is an answer: Hunk neither asks again nor loads them.
      expect(reviewed).not.toContain("Run this repository's extensions?");
      expect(reviewed).not.toContain("REPO EXTENSION ACTIVE");
      expect(reviewed).toContain("beta.ts");
    } finally {
      relaunched.close();
    }
  });

  test("the Extensions menu runs a registered command by mouse", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = harness.createRepoExtensionFixture(SIDEBAR_EXTENSION_SOURCE);
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--mode",
        "stack",
        "--extension",
        join(fixture.dir, ".hunk", "extensions", "fixture.ts"),
      ],
      cwd: fixture.dir,
      // The sidebar only renders on a "full" viewport, which starts at 220 columns.
      cols: 240,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      const before = await harness.waitForSnapshot(
        session,
        (text) => text.includes("alpha.ts") && !text.includes("Run this repository's extensions?"),
        20_000,
      );
      // The menu exists because an extension registered a command.
      expect(before).toContain("Extensions");
      expect(before).not.toContain("EXTSIDEBAR");

      await session.click(/Extensions/);
      // The dropdown names the command by its title and advertises its key.
      const menu = await session.waitForText(/Toggle fixture/, { timeout: 20_000 });
      expect(menu).toMatch(/Toggle fixture\s+y/);

      await session.click(/Toggle fixture/);
      const opened = await session.waitForText(/EXTSIDEBAR 2 FILES/, { timeout: 20_000 });
      expect(opened).toContain("alpha.ts");
    } finally {
      session.close();
    }
  });

  test("a command key opens an extension sidebar beside the built-in pane", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = harness.createRepoExtensionFixture(SIDEBAR_EXTENSION_SOURCE);
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--mode",
        "stack",
        // Load the fixture through the dev flag so it is trusted without a prompt.
        "--extension",
        join(fixture.dir, ".hunk", "extensions", "fixture.ts"),
      ],
      cwd: fixture.dir,
      // The sidebar only renders on a "full" viewport, which starts at 220 columns.
      cols: 240,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      // The extension view starts closed; only the built-in files pane shows.
      const before = await harness.waitForSnapshot(
        session,
        (text) => text.includes("alpha.ts") && !text.includes("Run this repository's extensions?"),
        20_000,
      );
      expect(before).not.toContain("EXTSIDEBAR");
      // The first keypress after the initial paint can be dropped before the
      // app subscribes its handler; prove the keyboard is live before the
      // press this test is actually about.
      await harness.ensureKeyboardIsLive(session);

      // The registered key dispatches through the shared command table and
      // opens the extension's right-hand pane beside the built-in one.
      await session.press("y");
      const opened = await session.waitForText(/EXTSIDEBAR 2 FILES/, { timeout: 20_000 });
      expect(opened).toContain("alpha.ts");

      // The same key toggles it away again.
      await session.press("y");
      await harness.waitForSnapshot(session, (text) => !text.includes("EXTSIDEBAR"), 20_000);
    } finally {
      session.close();
    }
  });

  test("the files shortcut and View menu follow a named pane slot", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = harness.createRepoExtensionFixture(FILES_SLOT_EXTENSION_SOURCE);
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--mode",
        "stack",
        "--extension",
        join(fixture.dir, ".hunk", "extensions", "fixture.ts"),
      ],
      cwd: fixture.dir,
      cols: 240,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("FILES SLOT RIGHT") && text.includes("AUX PANE LEFT"),
        20_000,
      );
      await harness.ensureKeyboardIsLive(session);

      await session.press("s");
      const closed = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("FILES SLOT RIGHT") && text.includes("AUX PANE LEFT"),
        20_000,
      );
      expect(closed).toContain("alpha.ts");

      await session.click(/View/);
      const menu = await session.waitForText(/Files pane/, { timeout: 20_000 });
      expect(menu).toContain("[ ] Files pane");

      await session.click(/Files pane/);
      const reopened = await harness.waitForSnapshot(
        session,
        (text) => text.includes("FILES SLOT RIGHT") && text.includes("AUX PANE LEFT"),
        20_000,
      );
      expect(reopened).toContain("alpha.ts");
    } finally {
      session.close();
    }
  });

  test("an extension can dock edge panes and resize through horizontal divider hit slop", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = harness.createRepoExtensionFixture(FOUR_EDGE_PANE_EXTENSION_SOURCE);
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--mode",
        "stack",
        "--extension",
        join(fixture.dir, ".hunk", "extensions", "fixture.ts"),
      ],
      cwd: fixture.dir,
      cols: 140,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });
    try {
      await harness.ensureKeyboardIsLive(session);
      await session.press("y");
      const frame = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("PANE TOP") && text.includes("PANE BOTTOM") && text.includes("alpha.ts"),
        20_000,
      );
      expect(frame).toContain("PANE TOP 138x2");
      expect(frame).toContain("PANE BOTTOM 138x2");

      // The visible divider is on row 3. Start one row below it to prove the
      // enlarged horizontal hit area wins over review-stream text selection.
      await dragMouse(session, 70, 4, 70, 6);
      await session.waitForText(/PANE TOP 138x4/, { timeout: 5_000 });

      await session.press("y");
      await harness.waitForSnapshot(
        session,
        (text) => !text.includes("PANE TOP") && !text.includes("PANE BOTTOM"),
        20_000,
      );
    } finally {
      session.close();
    }
  });

  test("a short terminal pins extension confirm actions for mouse acceptance", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = harness.createRepoExtensionFixture(DIALOG_EXTENSION_SOURCE);
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--mode",
        "stack",
        // Load the fixture through the dev flag so it is trusted without a prompt.
        "--extension",
        join(fixture.dir, ".hunk", "extensions", "fixture.ts"),
      ],
      cwd: fixture.dir,
      cols: 50,
      rows: 12,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      const before = await harness.waitForSnapshot(
        session,
        (text) => text.includes("alpha.ts") && !text.includes("Run this repository's extensions?"),
        20_000,
      );
      expect(before).not.toContain("Reformat the changeset?");
      await harness.ensureKeyboardIsLive(session);

      await session.press("y");
      const prompt = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Reformat the changeset?"),
        20_000,
      );
      expect(prompt).toContain("…");
      // The frame names the extension that raised the dialog, so a prompt
      // cannot present itself as Hunk asking.
      expect(prompt).toContain("ext fixture");
      expect(prompt).toContain("enter/y reformat");

      // The pinned action remains mouse-accessible even after body windowing.
      await session.click(/enter\/y reformat/);
      const answered = await harness.waitForSnapshot(
        session,
        (text) => text.includes("DIALOG ANSWERED YES"),
        20_000,
      );
      expect(answered).not.toContain("Reformat the changeset?");
    } finally {
      session.close();
    }
  });

  test("the real review-triage extension loads as a folder extension and exposes its menu commands", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = harness.createRepoExtensionFixture(TRANSFORM_EXTENSION_SOURCE);
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack", "--extension", REVIEW_TRIAGE_EXTENSION],
      cwd: fixture.dir,
      cols: 140,
      rows: 30,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      const before = await harness.waitForSnapshot(
        session,
        (text) => text.includes("alpha.ts") && text.includes("Extensions"),
        20_000,
      );
      expect(before).not.toContain("Review triage (session only)");

      // The command is a real Extensions-menu item, not a private menu hook.
      // `Extensions` also appears in the temporary fixture path, so target its chrome position.
      // Folder extension registration may finish after the first review frame, so retry the menu
      // gesture until the command itself proves that the extension is ready.
      let menu: string | null = null;
      for (let attempt = 0; attempt < 5 && menu === null; attempt += 1) {
        await session.clickAt(33, 0);
        try {
          menu = await harness.waitForSnapshot(
            session,
            (text) => text.includes("Toggle review triage"),
            3_000,
          );
        } catch {
          // A click may land before command registration or close an earlier empty menu; retry it.
        }
      }
      expect(menu).not.toBeNull();
      expect(menu!).toMatch(/Toggle review triage\s+y/);
      expect(menu).toMatch(/Mark selected hunk…\s+x/);
      expect(menu).toContain("Center current review line");
      expect(menu).toContain("Set review focus…");
      expect(menu).toContain("Clear triage decisions");
    } finally {
      session.close();
    }
  });

  test("the real Vim navigation example routes counts, command-line input, and Ctrl chords", async () => {
    const configHome = harness.createIsolatedConfigHome();
    // Enough changed rows that top/bottom navigation has an observable viewport effect.
    const fixture = harness.createPinnedHeaderRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack", "--extension", VIM_NAVIGATION_EXTENSION],
      cwd: fixture.dir,
      cols: 140,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("first.ts") && text.includes("Extensions"),
        20_000,
      );
      await harness.ensureKeyboardIsLive(session);
      await session.press("f6");
      await session.waitForText(/Vim navigation.*Esc exits/, { timeout: 20_000 });

      // The host contributes a mouse-accessible exit independently of the extension command.
      await session.clickAt(33, 0);
      await session.waitForText(/Exit Vim navigation/, { timeout: 20_000 });
      await session.click(/Exit Vim navigation/);
      await harness.waitForSnapshot(
        session,
        (text) => !/Vim navigation.*Esc exits/.test(text),
        20_000,
      );
      await session.press("f6");
      await session.waitForText(/Vim navigation.*Esc exits/, { timeout: 20_000 });

      // A passed `c` exposes the host-owned current line through note placement,
      // giving counted movement and alignment observable terminal effects.
      await session.press("c");
      const initialDraft = await session.waitForText(/Draft note/, { timeout: 20_000 });
      const initialDraftRow = lineIndexOf(initialDraft, "Draft note");
      await session.press("escape");
      await harness.waitForSnapshot(session, (text) => !text.includes("Draft note"), 20_000);

      await session.press("1");
      await session.press("0");
      await session.press("j");
      await session.press("c");
      const countedDraft = await session.waitForText(/Draft note/, { timeout: 20_000 });
      expect(lineIndexOf(countedDraft, "Draft note")).toBeGreaterThan(initialDraftRow);
      await session.press("escape");
      await harness.waitForSnapshot(session, (text) => !text.includes("Draft note"), 20_000);

      await session.press("z");
      await session.press("t");
      const topAligned = await session.text({ immediate: true });
      const topAlignedRow = lineIndexOf(topAligned, "export const line11 = 11;");

      await session.press("z");
      await session.press("z");
      const centered = await session.text({ immediate: true });
      expect(lineIndexOf(centered, "export const line11 = 11;")).toBeGreaterThan(topAlignedRow);

      // `;` passes into the registered command, whose focused host dialog owns even mode keys.
      await session.press(";");
      await session.waitForText(/Vim command \(;\)/, { timeout: 20_000 });
      await session.type("j-owned");
      await session.waitForText(/j-owned/, { timeout: 20_000 });
      await session.press("escape");
      await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Vim command (;)") && /Vim navigation.*Esc exits/.test(text),
        20_000,
      );

      await session.press(";");
      await session.waitForText(/Vim command \(;\)/, { timeout: 20_000 });
      await session.type("bottom");
      await session.press("enter");
      const commandBottom = await harness.waitForSnapshot(
        session,
        (text) => text.includes("second.ts") && !text.includes("first.ts"),
        20_000,
      );
      expect(commandBottom).toContain("second.ts");

      await session.press(";");
      await session.waitForText(/Vim command \(;\)/, { timeout: 20_000 });
      await session.type("top");
      await session.press("enter");
      const commandTop = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("first.ts") &&
          text.includes("export const line01 = 1;") &&
          !text.includes("second.ts"),
        20_000,
      );
      expect(commandTop).toContain("first.ts");

      await session.press(["ctrl", "d"]);
      const controlDown = await harness.waitForSnapshot(
        session,
        (text) => text.includes("first.ts") && !text.includes("export const line01 = 1;"),
        20_000,
      );
      expect(controlDown).toContain("first.ts");
      await session.press(["ctrl", "u"]);
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("export const line01 = 1;"),
        20_000,
      );

      // Both normal-mode absolute forms visibly move between the two long files.
      await session.press(["shift", "g"]);
      const bottom = await harness.waitForSnapshot(
        session,
        (text) => text.includes("second.ts") && !text.includes("first.ts"),
        20_000,
      );
      expect(bottom).toContain("second.ts");

      await session.press("g");
      await session.press("g");
      const top = await harness.waitForSnapshot(
        session,
        (text) => text.includes("first.ts") && !text.includes("second.ts"),
        20_000,
      );
      expect(top).toContain("first.ts");
      const active = await session.waitForText(/Vim navigation.*Esc exits/, {
        timeout: 20_000,
      });
      expect(active).toContain("Vim navigation");

      await session.press("escape");
      await harness.waitForSnapshot(
        session,
        (text) => !/Vim navigation.*Esc exits/.test(text),
        20_000,
      );
    } finally {
      session.close();
    }
  });

  test("a line highlighter marks the diff without disturbing it and refresh routes through controls", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = harness.createRepoExtensionFixture(LINE_HIGHLIGHT_EXTENSION_SOURCE);
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--mode",
        "stack",
        "--extension",
        join(fixture.dir, ".hunk", "extensions", "fixture.ts"),
      ],
      cwd: fixture.dir,
      cols: 140,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      // The marked line renders its exact text: highlights repaint backgrounds
      // and can never change, split, or reflow the code they sit on.
      const review = await harness.waitForSnapshot(
        session,
        (text) => text.includes("export const alphaValue = 2;"),
        20_000,
      );
      expect(review).toContain("alpha.ts");
      // A failing highlighter would have surfaced as an attributed warning toast.
      expect(review).not.toContain("line highlighter");
      // The first keypress after the initial paint can be dropped before the
      // app subscribes its handler; prove the keyboard is live first.
      await harness.ensureKeyboardIsLive(session);

      await session.press("f7");
      const refreshed = await session.waitForText(/marks refreshed/, { timeout: 20_000 });
      // The valid refresh raised only the fixture's own toast, no host warning.
      expect(refreshed).not.toContain("unknown line highlighter");
      // The re-derived marks still leave the reviewed text untouched.
      expect(refreshed).toContain("export const alphaValue = 2;");

      await session.press("f8");
      const warned = await session.waitForText(/unknown line highlighter/, { timeout: 20_000 });
      expect(warned).toContain('Extension fixture targeted unknown line highlighter "nope"');
    } finally {
      session.close();
    }
  });

  test("revealLine lands a line deep inside one tall hunk near the viewport top", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = harness.createRepoExtensionFixture(REVEAL_LINE_EXTENSION_SOURCE, "fixture.ts", [
      TALL_HUNK_FILE,
    ]);
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--mode",
        "stack",
        "--extension",
        join(fixture.dir, ".hunk", "extensions", "fixture.ts"),
      ],
      cwd: fixture.dir,
      cols: 140,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      const review = await harness.waitForSnapshot(
        session,
        (text) => text.includes("tall.ts"),
        20_000,
      );
      // This is the bug: the hunk anchor is on screen, the marked line is pages below it.
      expect(review).not.toContain(REVEAL_LINE_TOKEN);
      await harness.ensureKeyboardIsLive(session);

      await session.press("f7");
      const revealed = await harness.waitForSnapshot(
        session,
        (text) => text.includes(REVEAL_LINE_TOKEN),
        20_000,
      );
      // Near the top of a 24-row terminal, where every other Hunk reveal lands:
      // a little below the viewport edge, not scrolled just barely into view.
      const row = lineIndexOf(revealed, REVEAL_LINE_TOKEN);
      expect(row).toBeGreaterThan(0);
      expect(row).toBeLessThan(12);

      await session.press("f8");
      const warned = await session.waitForText(/revealLine found no/, { timeout: 20_000 });
      expect(warned).toContain("Extension fixture revealLine found no new line 9001");
    } finally {
      session.close();
    }
  });

  test("revealLine through pane actions held since mount still lands the line", async () => {
    // The first deferred jump of a session runs against actions minted before
    // any cursors were measured; it must land on the line, not the hunk anchor.
    const configHome = harness.createIsolatedConfigHome();
    const fixture = harness.createRepoExtensionFixture(
      REVEAL_LINE_MOUNT_ACTIONS_EXTENSION_SOURCE,
      "fixture.ts",
      [TALL_HUNK_FILE],
    );
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--mode",
        "stack",
        "--extension",
        join(fixture.dir, ".hunk", "extensions", "fixture.ts"),
      ],
      cwd: fixture.dir,
      cols: 140,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      const review = await harness.waitForSnapshot(
        session,
        (text) => text.includes("tall.ts") && text.includes("CAPTURE PANE"),
        20_000,
      );
      expect(review).not.toContain(REVEAL_LINE_TOKEN);
      await harness.ensureKeyboardIsLive(session);

      await session.press("f7");
      const revealed = await harness.waitForSnapshot(
        session,
        (text) => text.includes(REVEAL_LINE_TOKEN),
        20_000,
      );
      const row = lineIndexOf(revealed, REVEAL_LINE_TOKEN);
      expect(row).toBeGreaterThan(0);
      expect(row).toBeLessThan(12);
    } finally {
      session.close();
    }
  });

  test("a startup handler's notify renders as a toast and clears itself", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = harness.createRepoExtensionFixture(NOTIFY_EXTENSION_SOURCE);
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--mode",
        "stack",
        // Load the fixture through the dev flag so it is trusted without a prompt.
        "--extension",
        join(fixture.dir, ".hunk", "extensions", "fixture.ts"),
      ],
      cwd: fixture.dir,
      cols: 140,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      const toast = await session.waitForText(/hello from the fixture extension/, {
        timeout: 20_000,
      });
      expect(toast).toContain("ext hello from the fixture extension");

      const cleared = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("hello from the fixture extension"),
        15_000,
      );
      // The review itself is untouched once the transient toast retires.
      expect(cleared).toContain("alpha.ts");
    } finally {
      session.close();
    }
  });
});
