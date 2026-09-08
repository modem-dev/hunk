import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { getBundledVcsCatalog } from "../../app/vcsCatalog";
import type { CliInput } from "../run/commandInputs";
import { createVcsCatalog } from "../vcs";
import type { VcsAdapter } from "../vcs/types";
import { resolveWatchPlan as resolveCoreWatchPlan, type WatchPlanContext } from "./plan";

const cwd = posix.join("/", "workspace", "review");

/** Resolve with the app's bundled catalog unless a test supplies another. */
function resolveWatchPlan(input: CliInput, context: WatchPlanContext) {
  return resolveCoreWatchPlan(input, { vcsCatalog: getBundledVcsCatalog(), ...context });
}

/** Build one expected exact-entry target for a plan assertion. */
function entries(
  directory: string,
  paths: readonly string[],
  sources: ReadonlyArray<"content" | "sidecar">,
) {
  return {
    kind: "directory-entries" as const,
    directory,
    entries: [...paths],
    sources: [...sources],
  };
}

describe("resolveWatchPlan", () => {
  test.each([
    {
      name: "diff",
      input: {
        kind: "diff",
        left: "before/file.ts",
        right: "after/file.ts",
        options: {},
      } satisfies CliInput,
      targets: [
        entries(posix.join(cwd, "after"), [posix.join(cwd, "after", "file.ts")], ["content"]),
        entries(posix.join(cwd, "before"), [posix.join(cwd, "before", "file.ts")], ["content"]),
      ],
    },
    {
      name: "difftool without its display-only path",
      input: {
        kind: "difftool",
        left: "tmp/old.ts",
        right: "tmp/new.ts",
        path: "src/display-only.ts",
        options: {},
      } satisfies CliInput,
      targets: [
        entries(
          posix.join(cwd, "tmp"),
          [posix.join(cwd, "tmp", "new.ts"), posix.join(cwd, "tmp", "old.ts")],
          ["content"],
        ),
      ],
    },
    {
      name: "patch file",
      input: {
        kind: "patch",
        file: "incoming/review.patch",
        options: {},
      } satisfies CliInput,
      targets: [
        entries(
          posix.join(cwd, "incoming"),
          [posix.join(cwd, "incoming", "review.patch")],
          ["content"],
        ),
      ],
    },
  ])("plans directory entry targets for $name", ({ input, targets }) => {
    expect(resolveWatchPlan(input, { cwd, platform: "linux" })).toEqual({
      coverage: "hybrid",
      targets: [...targets],
    });
  });

  test("plans missing inputs from their paths without consulting the filesystem", () => {
    const input = {
      kind: "patch",
      file: "not-created-yet/review.patch",
      options: {},
    } satisfies CliInput;

    expect(resolveWatchPlan(input, { cwd, platform: "linux" })).toEqual({
      coverage: "hybrid",
      targets: [
        entries(
          posix.join(cwd, "not-created-yet"),
          [posix.join(cwd, "not-created-yet", "review.patch")],
          ["content"],
        ),
      ],
    });
  });

  test.each([
    {
      name: "diff",
      input: {
        kind: "diff",
        left: "left.ts",
        right: "right.ts",
        options: { agentContext: "notes/agent.json" },
      } satisfies CliInput,
      contentPaths: [posix.join(cwd, "left.ts"), posix.join(cwd, "right.ts")],
    },
    {
      name: "difftool",
      input: {
        kind: "difftool",
        left: "left.ts",
        right: "right.ts",
        path: "display.ts",
        options: { agentContext: "notes/agent.json" },
      } satisfies CliInput,
      contentPaths: [posix.join(cwd, "left.ts"), posix.join(cwd, "right.ts")],
    },
    {
      name: "patch file",
      input: {
        kind: "patch",
        file: "review.patch",
        options: { agentContext: "notes/agent.json" },
      } satisfies CliInput,
      contentPaths: [posix.join(cwd, "review.patch")],
    },
  ])("adds an agent sidecar target to $name", ({ input, contentPaths }) => {
    expect(resolveWatchPlan(input, { cwd, platform: "linux" })).toEqual({
      coverage: "hybrid",
      targets: [
        entries(cwd, contentPaths, ["content"]),
        entries(posix.join(cwd, "notes"), [posix.join(cwd, "notes", "agent.json")], ["sidecar"]),
      ],
    });
  });

  test("deduplicates same-parent and duplicate paths while retaining every exact entry", () => {
    const input = {
      kind: "diff",
      left: "src/./file.ts",
      right: "src/other/../file.ts",
      options: { agentContext: "src/notes.json" },
    } satisfies CliInput;

    expect(resolveWatchPlan(input, { cwd, platform: "linux" })).toEqual({
      coverage: "hybrid",
      targets: [
        entries(
          posix.join(cwd, "src"),
          [posix.join(cwd, "src", "file.ts"), posix.join(cwd, "src", "notes.json")],
          ["content", "sidecar"],
        ),
      ],
    });
  });

  test("preserves absolute paths instead of resolving them against cwd", () => {
    const input = {
      kind: "diff",
      left: "/snapshots/before.ts",
      right: "after.ts",
      options: {},
    } satisfies CliInput;

    expect(resolveWatchPlan(input, { cwd, platform: "linux" })).toEqual({
      coverage: "hybrid",
      targets: [
        entries("/snapshots", ["/snapshots/before.ts"], ["content"]),
        entries(cwd, [posix.join(cwd, "after.ts")], ["content"]),
      ],
    });
  });

  test.each([
    {
      name: "stdin patch",
      input: { kind: "patch", file: "-", options: {} } satisfies CliInput,
    },
    {
      name: "implicit stdin patch",
      input: { kind: "patch", text: "diff --git a/a b/a", options: {} } satisfies CliInput,
    },
    {
      name: "stdin agent context",
      input: {
        kind: "diff",
        left: "left.ts",
        right: "right.ts",
        options: { agentContext: "-" },
      } satisfies CliInput,
    },
  ])("leaves $name unwatchable", ({ input }) => {
    expect(resolveWatchPlan(input, { cwd, platform: "linux" })).toBeNull();
  });

  test("uses poll-only plans for adapters without event targets and adds file sidecars", () => {
    // `jj` resolves through the bundled extension tier: if watch planning did
    // not see bundled adapters, this would fail with "Unsupported VCS: jj".
    const vcsInput = { kind: "vcs", staged: false, options: { vcs: "jj" } } satisfies CliInput;
    const showInput = {
      kind: "show",
      options: { vcs: "jj", agentContext: "agent.json" },
    } satisfies CliInput;

    expect(resolveWatchPlan(vcsInput, { cwd, platform: "linux" })).toEqual({
      coverage: "poll-only",
      targets: [],
    });
    expect(resolveWatchPlan(showInput, { cwd, platform: "linux" })).toEqual({
      coverage: "hybrid",
      targets: [entries(cwd, [posix.join(cwd, "agent.json")], ["sidecar"])],
    });
  });

  test("plans through an extension adapter's watch capability", () => {
    const target = {
      kind: "directory-tree" as const,
      directory: posix.join(cwd, ".hg"),
      ignoredRoots: [],
      sources: ["vcs-metadata" as const],
    };
    const adapter: VcsAdapter = {
      id: "hg",
      name: "Mercurial",
      detect: () => null,
      operations: {
        "working-tree-diff": {
          load: async () => ({ repoRoot: cwd, sourceLabel: cwd, title: "hg", patchText: "" }),
          watchPlan: () => ({ coverage: "hybrid", targets: [target] }),
        },
      },
    };
    const input = { kind: "vcs", staged: false, options: { vcs: "hg" } } satisfies CliInput;

    expect(
      resolveWatchPlan(input, {
        cwd,
        platform: "linux",
        vcsCatalog: createVcsCatalog([adapter], "hg", []),
      }),
    ).toEqual({
      coverage: "hybrid",
      targets: [target],
    });
  });

  test("keeps the polling fallback for an extension adapter with no watch plan", () => {
    const adapter: VcsAdapter = {
      id: "hg",
      name: "Mercurial",
      detect: () => null,
      operations: {
        "working-tree-diff": {
          load: async () => ({ repoRoot: cwd, sourceLabel: cwd, title: "hg", patchText: "" }),
        },
      },
    };
    const input = { kind: "vcs", staged: false, options: { vcs: "hg" } } satisfies CliInput;

    expect(
      resolveWatchPlan(input, {
        cwd,
        platform: "linux",
        vcsCatalog: createVcsCatalog([adapter], "hg", []),
      }),
    ).toEqual({
      coverage: "poll-only",
      targets: [],
    });
  });

  test("normalizes and deduplicates synthetic Windows paths with win32 helpers", () => {
    const windowsCwd = "C:\\work\\review";
    const input = {
      kind: "diff",
      left: "src\\before.ts",
      right: "C:/work/review/src/after.ts",
      options: { agentContext: "/c/work/review/src/agent.json" },
    } satisfies CliInput;

    expect(resolveWatchPlan(input, { cwd: windowsCwd, platform: "win32" })).toEqual({
      coverage: "hybrid",
      targets: [
        entries(
          win32.join(windowsCwd, "src"),
          [
            win32.join(windowsCwd, "src", "after.ts"),
            win32.join(windowsCwd, "src", "agent.json"),
            win32.join(windowsCwd, "src", "before.ts"),
          ],
          ["content", "sidecar"],
        ),
      ],
    });
  });
});
