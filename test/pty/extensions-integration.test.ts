import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

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
