import { describe, expect, test } from "bun:test";
import { createTestStatusSnapshot } from "../../../../../test/helpers/vcsStatus";
import { formatStatusUpstream, projectStaticStatus } from "./staticProjection";
import { runStaticStatus, type StaticStatusRuntime } from "./runStaticStatus";
import { resolveTheme } from "../themes";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";

describe("static workspace status", () => {
  test("formats divergence without zero counters or invented fetch times", () => {
    const tracked = {
      kind: "tracked" as const,
      name: "origin/main",
      ahead: 0,
      behind: 1,
      fetch: { state: "unknown" as const, reason: "No metadata" },
    };
    expect(formatStatusUpstream({ state: "ready", value: tracked })).toBe("1 behind origin/main");
    expect(formatStatusUpstream({ state: "ready", value: { ...tracked, ahead: 3 } })).toBe(
      "3 ahead · 1 behind origin/main",
    );
    expect(formatStatusUpstream({ state: "ready", value: { ...tracked, behind: 0 } })).toBe(
      "Aligned with origin/main",
    );
    const snapshot = createTestStatusSnapshot();
    snapshot.upstream = {
      state: "ready",
      value: {
        ...tracked,
        fetch: {
          state: "ready",
          value: { timestamp: "2026-01-02T03:04:05Z", provenance: "local-fetch-head-mtime" },
        },
      },
    };
    expect(formatStatusUpstream(snapshot.upstream)).toBe("1 behind origin/main");
    const output = projectStaticStatus(snapshot);
    expect(output).not.toContain("local fetch");
    expect(output).not.toContain("last fetched");
    expect(JSON.parse(JSON.stringify(snapshot)).upstream.value.fetch).toEqual({
      state: "ready",
      value: { timestamp: "2026-01-02T03:04:05Z", provenance: "local-fetch-head-mtime" },
    });
  });
  test("shows mixed states without a selected-file inspector and escapes untrusted paths", () => {
    const snapshot = createTestStatusSnapshot("worktree\nforged");
    snapshot.paths = [
      {
        path: "new\t名",
        previousPath: "old\nname",
        index: "renamed",
        worktree: "modified",
        conflict: false,
      },
    ];
    snapshot.changedPathCount = 1;
    const output = projectStaticStatus(snapshot);
    expect(output).toContain("worktree\\nforged");
    expect(output).toContain("old\\nname -> new\\t名  renamed (staged) · modified (unstaged)");
    expect(output).toContain("1 changed path");
    expect(output).not.toContain("Selected");
    const theme = resolveTheme("status-test", null, [
      { id: "status-test", base: "nord", accent: "#123456" },
    ]);
    expect(projectStaticStatus(snapshot, { theme, color: true })).toContain("\x1b[38;2;18;52;86m");
  });
  test("JSON uses the same facts, skips paging/color, and cleans up after output failure", async () => {
    const snapshot = createTestStatusSnapshot();
    let closed = 0;
    let shutdown = 0;
    let pages = 0;
    let output = "";
    const runtime: StaticStatusRuntime = {
      input: { kind: "status", json: true, static: false, color: "always", options: {} },
      initialization: {
        theme: { customThemes: [] },
        viewPreferences: persistedViewPreferencesFromOptions({}),
      },
      snapshot,
      notices: [],
      async loadSiblings(value) {
        return { ...value, siblings: { state: "error", message: "partial" } };
      },
      async close() {
        closed++;
      },
      extensionSession: {
        async shutdown() {
          shutdown++;
        },
      },
    };
    await runStaticStatus(runtime, {
      stdout: { isTTY: true, rows: 1 },
      write(text) {
        output = text;
      },
      async pageText() {
        pages++;
      },
    });
    expect(JSON.parse(output)).toMatchObject({
      schemaVersion: 1,
      siblings: { state: "error", message: "partial" },
    });
    expect(output).not.toContain("\x1b");
    expect(pages).toBe(0);
    expect(closed).toBe(1);
    expect(shutdown).toBe(1);
    await expect(
      runStaticStatus(runtime, {
        write() {
          throw new Error("output failed");
        },
      }),
    ).rejects.toThrow("output failed");
    expect(closed).toBe(2);
    expect(shutdown).toBe(2);
    runtime.input.json = false;
    await runStaticStatus(runtime, {
      stdout: { isTTY: true, rows: 1 },
      async pageText() {
        pages++;
      },
    });
    expect(pages).toBe(1);
  });
});

test("status labels color staging state, not modification type, in both themed and plain output", () => {
  const theme = resolveTheme("status-signs", null, [
    {
      id: "status-signs",
      base: "nord",
      addedSignColor: "#123456",
      removedSignColor: "#654321",
      accent: "#abcdef",
      text: "#eeeeee",
      fileDeleted: "#010203",
      fileUntracked: "#030201",
    },
  ]);
  const snapshot = createTestStatusSnapshot();
  snapshot.paths = [
    { path: "staged-delete", index: "deleted", worktree: "unchanged", conflict: false },
    { path: "unstaged-add", index: "unchanged", worktree: "added", conflict: false },
    { path: "mixed", index: "modified", worktree: "modified", conflict: false },
    { path: "untracked", index: "unchanged", worktree: "untracked", conflict: false },
    { path: "conflicted", index: "unmerged", worktree: "unmerged", conflict: true },
    { path: "no-index", worktree: "modified", conflict: false },
  ];
  snapshot.changedPathCount = snapshot.paths.length;
  const output = projectStaticStatus(snapshot, { theme, color: true });
  const green = "\x1b[38;2;18;52;86m";
  const red = "\x1b[38;2;101;67;33m";
  const attention = "\x1b[38;2;171;205;239m";
  expect(output).toContain(`${green}deleted (staged)\x1b[0m`);
  expect(output).toContain(`${green}staged-delete\x1b[0m`);
  expect(output).toContain(`${red}new file (unstaged)\x1b[0m`);
  expect(output).toContain(`${red}unstaged-add\x1b[0m`);
  expect(output).toContain(`${green}modified (staged)\x1b[0m`);
  expect(output).toContain(`${red}modified (unstaged)\x1b[0m`);
  expect(output).toContain("\x1b[38;2;238;238;238mmixed\x1b[0m");
  expect(output).toContain(`${red}untracked\x1b[0m`);
  expect(output).toContain(`${attention}unmerged (staged)\x1b[0m`);
  expect(output).toContain(`${attention}conflict\x1b[0m`);
  const plain = projectStaticStatus(snapshot, { theme, color: false });
  expect(plain).not.toContain("\x1b");
  for (const row of [
    "  staged-delete  deleted (staged)",
    "  unstaged-add  new file (unstaged)",
    "  mixed  modified (staged) · modified (unstaged)",
    "Untracked files (1)\n  untracked\n",
    "  conflicted  unmerged (staged) · unmerged (unstaged) · conflict",
    "  no-index  modified",
  ])
    expect(plain).toContain(row);
  expect(plain).not.toContain("Index / worktree");
  expect(plain).not.toContain("unchanged");
  expect(plain).toContain("\n\n── Other worktrees ──\n");
  expect(plain).not.toContain("index:");
});

test("static groups retain every unique path without unusable expansion actions", () => {
  const snapshot = createTestStatusSnapshot();
  snapshot.paths = Array.from({ length: 25 }, (_, i) => [
    {
      path: `tracked-${i}`,
      index: "modified" as const,
      worktree: "unchanged" as const,
      conflict: false,
    },
    {
      path: `new-${i}`,
      index: "unchanged" as const,
      worktree: "untracked" as const,
      conflict: false,
    },
  ]).flat();
  snapshot.paths.push(snapshot.paths[0]!);
  const before = JSON.stringify(snapshot);
  const output = projectStaticStatus(snapshot);
  expect(output).toContain("50 changed paths\nTracked changes (25)");
  expect(output).toContain("Untracked files (25)");
  for (let i = 0; i < 25; i++) {
    expect(output).toContain(`  tracked-${i}  modified (staged)\n`);
    expect(output).toContain(`  new-${i}\n`);
  }
  expect(output.match(/  tracked-0 /g)).toHaveLength(1);
  expect(output).not.toMatch(/more files|Show fewer|unchanged|Index \/ worktree/);
  expect(JSON.stringify(snapshot)).toBe(before);
});

test("tracked facts distinguish rename, copy, type changes and submodules without unchanged labels", () => {
  const snapshot = createTestStatusSnapshot();
  snapshot.paths = [
    {
      path: "renamed",
      previousPath: "old-name",
      index: "renamed",
      worktree: "unchanged",
      conflict: false,
    },
    {
      path: "copy",
      previousPath: "source",
      index: "copied",
      worktree: "type-changed",
      conflict: false,
    },
    {
      path: "module",
      index: "unchanged",
      worktree: "modified",
      conflict: false,
      submodule: { commitChanged: true, trackedChanges: true, untrackedChanges: true },
    },
  ];
  const output = projectStaticStatus(snapshot);
  expect(output).toContain("  old-name -> renamed  renamed (staged)");
  expect(output).toContain("  source -> copy  copied (staged) · type changed (unstaged)");
  expect(output).toContain(
    "  module  modified (unstaged) · submodule commit changed tracked changes untracked changes",
  );
  expect(output).not.toMatch(/unchanged|Index \/ worktree|XY/);
});
