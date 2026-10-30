import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryCommandInput } from "../core/run/commandInputs";
import type { VcsAdapter, VcsCatalog, VcsHistorySource } from "../core/vcs/types";
import { loadHistoryBootstrap } from "./historyBootstrap";
import { loadStatusBootstrap } from "./statusBootstrap";
import { createTestStatusSnapshot } from "../../../../test/helpers/vcsStatus";

const input: HistoryCommandInput = {
  kind: "history",
  color: "never",
  format: "compact",
  ascii: false,
  static: false,
  vcs: "test",
  extensionsEnabled: false,
  extensionPaths: [],
};

describe("history bootstrap cursor ownership", () => {
  test("cancels refresh before opening and closes each active provider cursor once", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hunk-history-bootstrap-"));
    const configHome = mkdtempSync(join(tmpdir(), "hunk-history-config-"));
    const configPath = join(configHome, "hunk", "config.toml");
    mkdirSync(join(configHome, "hunk"), { recursive: true });
    writeFileSync(
      configPath,
      'theme = "github-dark-dimmed"\nline_numbers = false\nprompt_save_view_preferences = false\n\n[keybindings]\n"hunk.history.nextCommit" = "ctrl+n"\n',
    );
    const closeCounts: number[] = [];
    let opens = 0;
    const makeSource = (): VcsHistorySource => {
      const index = opens++;
      closeCounts[index] = 0;
      return {
        async read() {
          return { commits: [], done: true };
        },
        async close() {
          closeCounts[index]! += 1;
        },
      };
    };
    const adapter: VcsAdapter = {
      id: "test",
      name: "Test",
      detect: () => ({ id: "test", repoRoot: cwd }),
      operations: {},
      history: {
        async open() {
          return makeSource();
        },
        async planReview(commit) {
          return { kind: "revision-show", revisionId: commit.revisionId };
        },
      },
    };
    const catalog: VcsCatalog = {
      adapters: [adapter],
      defaultAdapterId: "test",
      reservedIds: new Set(["test"]),
    };

    try {
      const bootstrap = await loadHistoryBootstrap({
        input,
        cwd,
        env: { ...process.env, XDG_CONFIG_HOME: configHome },
        baseVcsCatalog: catalog,
      });
      expect(bootstrap.input.theme).toBe("github-dark-dimmed");
      expect(bootstrap.customThemes).toEqual([]);
      expect(bootstrap.initialization).toEqual({
        theme: {
          initialTheme: "github-dark-dimmed",
          customThemes: [],
        },
        viewPreferences: bootstrap.initialViewPreferences,
      });
      expect(bootstrap.initialViewPreferences).toMatchObject({
        theme: "github-dark-dimmed",
        showLineNumbers: false,
      });
      expect(bootstrap.keybindings).toEqual({ "hunk.history.nextCommit": "ctrl+n" });
      expect(bootstrap.viewPreferencesConfigPath).toBe(configPath);
      expect(bootstrap.promptSaveViewPreferences).toBe(false);

      const cancelled = new AbortController();
      cancelled.abort();
      await expect(bootstrap.reopenSource(cancelled.signal)).rejects.toThrow();
      expect(opens).toBe(1);

      await bootstrap.reopenSource();
      expect(opens).toBe(2);
      expect(closeCounts).toEqual([1, 0]);
      await bootstrap.close();
      await bootstrap.close();
      expect(closeCounts).toEqual([1, 1]);
      expect(bootstrap.extensionSession.current.registry.eventBusPhase).toBe("ready");
      await bootstrap.extensionSession.shutdown();
      await bootstrap.extensionSession.shutdown();
      expect(bootstrap.extensionSession.current.registry.eventBusPhase).toBe("closed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
    }
  });
});

/** Exercise cursor lifetime through both public bootstrap workflows, without a terminal. */
async function createTestCursorBootstrap(origin: "history" | "status") {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-cursor-lifetime-"));
  const configHome = mkdtempSync(join(tmpdir(), "hunk-cursor-config-"));
  const counts: number[] = [];
  let open: (() => Promise<VcsHistorySource>) | undefined;
  let close: ((index: number) => Promise<void>) | undefined;

  /** Return a cursor whose disposal can be held independently from provider opening. */
  const createTestSource = (): VcsHistorySource => {
    const index = counts.length;
    counts.push(0);
    return {
      async read() {
        return { commits: [], done: true };
      },
      async close() {
        counts[index]!++;
        await close?.(index);
      },
    };
  };
  const adapter: VcsAdapter = {
    id: "test",
    name: "Test",
    detect: () => ({ id: "test", repoRoot: cwd }),
    operations: {},
    history: {
      open: () => (open ? open() : Promise.resolve(createTestSource())),
      async planReview(commit) {
        return { kind: "revision-show", revisionId: commit.revisionId };
      },
    },
    status: {
      async read() {
        return createTestStatusSnapshot(cwd);
      },
      async readSiblings() {
        return { worktrees: [], truncated: false };
      },
      async planReview() {
        return { cwd, input: { kind: "vcs", staged: false, options: {} } };
      },
    },
  };
  const baseVcsCatalog: VcsCatalog = {
    adapters: [adapter],
    defaultAdapterId: "test",
    reservedIds: new Set(["test"]),
  };
  const common = { cwd, env: { ...process.env, XDG_CONFIG_HOME: configHome }, baseVcsCatalog };
  const status =
    origin === "status"
      ? await loadStatusBootstrap({
          ...common,
          input: {
            kind: "status",
            static: false,
            json: false,
            color: "never",
            options: { vcs: "test", extensions: false },
          },
        })
      : undefined;
  const bootstrap = status
    ? await status.openHistory(cwd)
    : await loadHistoryBootstrap({ ...common, input });
  return {
    bootstrap,
    counts,
    createTestSource,
    holdOpen(next: () => Promise<VcsHistorySource>) {
      open = next;
    },
    holdClose(next: (index: number) => Promise<void>) {
      close = next;
    },
    async cleanup() {
      await bootstrap.close();
      await status?.close();
      await bootstrap.extensionSession.shutdown();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
    },
  };
}

for (const origin of ["history", "status"] as const) {
  test(`${origin} close drains a late cursor open and repeated close shares its settlement`, async () => {
    const fixture = await createTestCursorBootstrap(origin);
    let finishOpen!: (source: VcsHistorySource) => void;
    fixture.holdOpen(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(fixture.bootstrap.reopenSource(cancelled.signal)).rejects.toThrow();
    expect(fixture.counts).toEqual([0]);
    const refresh = fixture.bootstrap.reopenSource();
    void refresh.catch(() => undefined);
    let released = false;
    let closed = false;
    const closing = fixture.bootstrap.close().then(() => {
      closed = true;
    });
    let repeatClosed = false;
    const repeat = fixture.bootstrap.close().then(() => {
      repeatClosed = true;
    });
    try {
      await Bun.sleep(0);
      expect(closed).toBe(false);
      expect(repeatClosed).toBe(false);
      expect(fixture.counts).toEqual([1]);
      finishOpen(fixture.createTestSource());
      released = true;
      await expect(refresh).rejects.toThrow("closed");
      await Promise.all([closing, repeat]);
      expect(fixture.counts).toEqual([1, 1]);
      await expect(fixture.bootstrap.reopenSource()).rejects.toThrow("closed");
    } finally {
      if (!released) finishOpen?.(fixture.createTestSource());
      await fixture.cleanup();
    }
  });

  test(`${origin} close drains previous cursor cleanup after replacement adoption`, async () => {
    const fixture = await createTestCursorBootstrap(origin);
    let finishClose!: () => void;
    fixture.holdClose((index) =>
      index === 0
        ? new Promise((resolve) => {
            finishClose = resolve;
          })
        : Promise.resolve(),
    );
    const refresh = fixture.bootstrap.reopenSource();
    try {
      await Bun.sleep(0);
      expect(fixture.counts).toEqual([1, 0]);
      let closed = false;
      const closing = fixture.bootstrap.close().then(() => {
        closed = true;
      });
      await Bun.sleep(0);
      expect(fixture.counts).toEqual([1, 1]);
      expect(closed).toBe(false);
      finishClose();
      await Promise.all([refresh, closing]);
      expect(closed).toBe(true);
      expect(fixture.counts).toEqual([1, 1]);
    } finally {
      finishClose?.();
      await fixture.cleanup();
    }
  });
}
