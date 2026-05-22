import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestListedSession } from "../../test/helpers/session-daemon-fixtures";
import type { HunkSessionCliClient } from "../hunk-session/cli";
import type { ListedSession } from "../hunk-session/types";
import {
  parseKittyState,
  resolveActiveKittyPane,
  selectKittyFollowTarget,
  syncKittyFollowSession,
} from "./sync";

const tempDirs: string[] = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-kitty-sync-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createKittyState({
  activeWindowId = 10,
  hunkWindowId = 99,
  cwd,
  foregroundCwd = cwd,
  foregroundCmdline = ["-zsh"],
}: {
  activeWindowId?: number;
  hunkWindowId?: number;
  cwd: string;
  foregroundCwd?: string;
  foregroundCmdline?: string[];
}) {
  return parseKittyState([
    {
      id: 1,
      is_focused: true,
      is_active: true,
      tabs: [
        {
          id: 2,
          is_active: true,
          windows: [
            {
              id: activeWindowId,
              is_active: true,
              cwd,
              cmdline: ["/bin/zsh"],
              foreground_processes: [{ cmdline: foregroundCmdline, cwd: foregroundCwd }],
            },
            {
              id: hunkWindowId,
              is_active: false,
              cwd,
              cmdline: ["/bin/zsh"],
              foreground_processes: [{ cmdline: ["hunk", "diff", "--kitty-follow"], cwd }],
            },
          ],
        },
      ],
    },
  ]);
}

function createClient(sessions: ListedSession[]) {
  const reloads: unknown[] = [];
  const client = {
    listSessions: async () => sessions,
    reloadSession: async (input: unknown) => {
      reloads.push(input);
      return {
        sessionId: sessions[0]?.sessionId ?? "session-1",
        inputKind: "vcs",
        title: "repo working tree",
        sourceLabel: "/repo",
        fileCount: 3,
        selectedHunkIndex: 0,
      };
    },
  } as unknown as HunkSessionCliClient;

  return { client, reloads };
}

function createFollowSession(overrides: Partial<ListedSession> = {}) {
  return createTestListedSession({
    sessionId: "follow-1",
    repoRoot: "/old-repo",
    kittyFollow: true,
    terminal: {
      locations: [{ source: "kitty", windowId: "99" }],
    },
    ...overrides,
  });
}

describe("Kitty follow sync", () => {
  test("resolves the active Kitty pane and rejects stale focus events", () => {
    const cwd = createTempDir();
    const state = createKittyState({ cwd, activeWindowId: 10 });

    const activePane = resolveActiveKittyPane(state, "10");
    expect(typeof activePane).toBe("object");
    if (typeof activePane === "object") {
      expect(activePane.window.id).toBe(10);
    }

    expect(resolveActiveKittyPane(state, "99")).toBe("kitty-window-not-active");
  });

  test("selects the marked Hunk session in the same Kitty OS window", () => {
    const cwd = createTempDir();
    const state = createKittyState({ cwd });
    const sameOs = createFollowSession({ sessionId: "same-os" });
    const otherOs = createFollowSession({
      sessionId: "other-os",
      terminal: { locations: [{ source: "kitty", windowId: "404" }] },
    });

    expect(selectKittyFollowTarget([sameOs, otherOs], state, 1)).toEqual(sameOs);
  });

  test("reloads the selected marked session from the active pane foreground cwd", async () => {
    const cwd = createTempDir();
    const state = createKittyState({ cwd });
    const { client, reloads } = createClient([createFollowSession()]);

    const result = await syncKittyFollowSession(
      { kind: "kitty", action: "sync", output: "json", windowId: "10" },
      {
        client,
        loadKittyState: async () => state,
        detectRepo: () => ({ id: "git", repoRoot: cwd }),
      },
    );

    expect(result).toMatchObject({
      status: "reloaded",
      sessionId: "follow-1",
      cwd,
      repoRoot: cwd,
    });
    expect(reloads).toEqual([
      expect.objectContaining({
        selector: { sessionId: "follow-1" },
        sourcePath: cwd,
        nextInput: { kind: "vcs", staged: false, options: {} },
      }),
    ]);
  });

  test("no-ops for non-repo panes and active Hunk panes", async () => {
    const cwd = createTempDir();
    const sessions = [createFollowSession()];
    const { client } = createClient(sessions);

    const nonRepo = await syncKittyFollowSession(
      { kind: "kitty", action: "sync", output: "json", windowId: "10" },
      {
        client,
        loadKittyState: async () => createKittyState({ cwd }),
        detectRepo: () => null,
      },
    );
    expect(nonRepo).toMatchObject({ status: "noop", reason: "not-a-repo" });

    const activeHunk = await syncKittyFollowSession(
      { kind: "kitty", action: "sync", output: "json", windowId: "99" },
      {
        client,
        loadKittyState: async () => createKittyState({ cwd, activeWindowId: 99 }),
        detectRepo: () => ({ id: "git", repoRoot: cwd }),
      },
    );
    expect(activeHunk).toMatchObject({ status: "noop", reason: "active-hunk-window" });
  });

  test("no-ops when multiple marked sessions remain ambiguous", async () => {
    const cwd = createTempDir();
    const state = parseKittyState([
      {
        id: 1,
        is_focused: true,
        is_active: true,
        tabs: [
          {
            id: 2,
            is_active: true,
            windows: [
              {
                id: 10,
                is_active: true,
                cwd,
                cmdline: ["/bin/zsh"],
                foreground_processes: [{ cmdline: ["-zsh"], cwd }],
              },
            ],
          },
        ],
      },
    ]);
    const { client } = createClient([
      createFollowSession({ sessionId: "one", terminal: undefined }),
      createFollowSession({ sessionId: "two", terminal: undefined }),
    ]);

    const result = await syncKittyFollowSession(
      { kind: "kitty", action: "sync", output: "json", windowId: "10" },
      {
        client,
        loadKittyState: async () => state,
        detectRepo: () => ({ id: "git", repoRoot: cwd }),
      },
    );

    expect(result).toMatchObject({ status: "noop", reason: "ambiguous-target" });
  });
});
