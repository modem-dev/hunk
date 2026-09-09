import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestStatusSnapshot } from "../../../../test/helpers/vcsStatus";
import type { VcsAdapter, VcsCatalog } from "../core/vcs/types";
import { loadStatusBootstrap } from "./statusBootstrap";

/** Create isolated launch/config fixtures and a provider with controllable status reads. */
function createTestStatusBootstrapFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-status-bootstrap-"));
  const configHome = mkdtempSync(join(tmpdir(), "hunk-status-config-"));
  mkdirSync(join(configHome, "hunk"));
  const configPath = join(configHome, "hunk", "config.toml");
  writeFileSync(
    configPath,
    'theme = "nord"\nline_numbers = false\nwrap = true\nprompt_save_view_preferences = false\n\n[keybindings]\n"hunk.history.nextCommit" = "ctrl+n"\n',
  );
  const adapter: VcsAdapter = {
    id: "test",
    name: "Test",
    detect: () => ({ id: "test", repoRoot: cwd }),
    operations: {},
    status: {
      async read({ targetPath }) {
        return createTestStatusSnapshot(targetPath ?? cwd);
      },
      async readSiblings() {
        return { worktrees: [], truncated: false };
      },
      async planReview(snapshot) {
        return { cwd: snapshot.worktree.path, input: { kind: "vcs", staged: false, options: {} } };
      },
    },
  };
  const catalog: VcsCatalog = {
    adapters: [adapter],
    defaultAdapterId: "test",
    reservedIds: new Set(["test"]),
  };
  return {
    cwd,
    adapter,
    configPath,
    load: () =>
      loadStatusBootstrap({
        input: {
          kind: "status",
          static: false,
          json: false,
          color: "never",
          options: {
            vcs: "test",
            extensions: false,
            experimental: true,
            theme: "github-light-default",
          },
        },
        cwd,
        env: { ...process.env, XDG_CONFIG_HOME: configHome },
        baseVcsCatalog: catalog,
      }),
    cleanup() {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
    },
  };
}

describe("status bootstrap launch authority", () => {
  test("retains resolved launch preferences/extensions while target reads stay explicit", async () => {
    const fixture = createTestStatusBootstrapFixture();
    const bootstrap = await fixture.load();
    try {
      expect(bootstrap.launchOptions).toMatchObject({
        experimental: true,
        theme: "github-light-default",
        lineNumbers: false,
      });
      expect(bootstrap.initialization.viewPreferences).toMatchObject({
        theme: "github-light-default",
        showLineNumbers: false,
      });
      expect(bootstrap.initialization.theme.initialTheme).toBe("github-light-default");
      expect(bootstrap.keybindings).toEqual({ "hunk.history.nextCommit": "ctrl+n" });
      expect(bootstrap.viewPreferencesConfigPath).toBe(fixture.configPath);
      expect(bootstrap.promptSaveViewPreferences).toBe(false);
      const registry = bootstrap.extensionSession.current.registry;
      const target = join(fixture.cwd, "sibling");
      expect((await bootstrap.load(target)).worktree.path).toBe(target);
      expect(bootstrap.startupCwd).toBe(fixture.cwd);
      expect(bootstrap.extensionSession.cwd).toBe(fixture.cwd);
      expect(bootstrap.extensionSession.current.registry).toBe(registry);
      expect((await bootstrap.loadSiblings(bootstrap.snapshot)).siblings).toEqual({
        state: "ready",
        value: { worktrees: [], truncated: false },
      });
      expect(await bootstrap.watchPlan(bootstrap.snapshot)).toEqual({
        coverage: "poll-only",
        targets: [],
      });
      await bootstrap.close();
      await bootstrap.close();
      expect(registry.eventBusPhase).toBe("ready");
      await expect(bootstrap.load()).rejects.toThrow("closed");
      await bootstrap.extensionSession.shutdown();
      expect(registry.eventBusPhase).toBe("closed");
    } finally {
      await bootstrap.close();
      await bootstrap.extensionSession.shutdown();
      fixture.cleanup();
    }
  });
  test("contains sibling enumeration failure and drains reads cancelled at session close", async () => {
    const fixture = createTestStatusBootstrapFixture();
    fixture.adapter.status!.readSiblings = async () => {
      throw new Error("partial scan unavailable");
    };
    const bootstrap = await fixture.load();
    try {
      expect((await bootstrap.loadSiblings(bootstrap.snapshot)).siblings).toEqual({
        state: "error",
        message: "partial scan unavailable",
      });
      fixture.adapter.status!.read = async (_input, { signal }) => {
        signal?.throwIfAborted();
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        return createTestStatusSnapshot();
      };
      const late = bootstrap.load();
      void late.catch(() => undefined);
      await bootstrap.close();
      await expect(late).rejects.toThrow("closed");
    } finally {
      await bootstrap.close();
      await bootstrap.extensionSession.shutdown();
      fixture.cleanup();
    }
  });
  test("reports unsupported providers rather than substituting Git index semantics", async () => {
    const fixture = createTestStatusBootstrapFixture();
    delete fixture.adapter.status;
    try {
      await expect(fixture.load()).rejects.toThrow("does not support workspace status");
    } finally {
      fixture.cleanup();
    }
  });
});
