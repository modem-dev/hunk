import { join } from "node:path";
import type { StatusRuntime } from "../../packages/hunk/src/ui/status/types";
import { persistedViewPreferencesFromOptions } from "../../packages/hunk/src/core/run/config";
import { createTestExtensionSession } from "./extension-session";
import { createTestStatusSnapshot } from "./vcsStatus";
import { createTestVcsAppBootstrap } from "./app-bootstrap";
import { createTestDiffFile } from "./diff-helpers";

/** Create status resources with real borrowed extension ownership and no filesystem watchers. */
export function createTestStatusRuntime(): StatusRuntime {
  const snapshot = createTestStatusSnapshot(join(process.cwd(), "status-test-origin"));
  snapshot.paths = [
    { path: "alpha.ts", index: "modified", worktree: "modified", conflict: false },
    { path: "beta.ts", index: "unchanged", worktree: "modified", conflict: false },
  ];
  snapshot.changedPathCount = 2;
  snapshot.reviewActions = [
    { id: "staged", label: "Review staged changes" },
    { id: "unstaged", label: "Review unstaged changes" },
  ];
  snapshot.siblings = {
    state: "ready",
    value: {
      truncated: false,
      worktrees: [
        {
          worktree: {
            ...snapshot.worktree,
            id: "sibling",
            path: join(process.cwd(), "status-test-sibling"),
          },
          branch: "sibling-branch",
          detached: false,
          bare: false,
          inspectable: true,
          status: {
            state: "ready",
            observedAt: snapshot.observedAt,
            changedPathCount: 0,
            conflictCount: 0,
            operations: { state: "ready", value: [] },
          },
        },
      ],
    },
  };
  const preferences = persistedViewPreferencesFromOptions({ theme: "nord", experimental: true });
  const runtime: StatusRuntime = {
    input: { kind: "status", static: false, json: false, color: "always", options: {} },
    snapshot,
    providerId: "test",
    providerName: "Test",
    startupCwd: process.cwd(),
    launchOptions: { experimental: true },
    extensionSession: createTestExtensionSession(),
    initialization: {
      theme: {
        initialTheme: "nord",
        customThemes: [{ id: "status-custom", label: "Status custom", accent: "#123456" }],
      },
      viewPreferences: preferences,
    },
    keybindings: {},
    initialViewPreferences: preferences,
    promptSaveViewPreferences: false,
    notices: [],
    async load(path) {
      return path === snapshot.worktree.path || !path
        ? structuredClone(snapshot)
        : {
            ...structuredClone(snapshot),
            worktree: { ...snapshot.worktree, id: "sibling", path },
            head: { kind: "branch", name: "sibling-branch", revisionId: "b" },
            siblings: { state: "ready", value: { worktrees: [], truncated: false } },
          };
    },
    async loadSiblings(snapshot) {
      return snapshot;
    },
    async watchPlan() {
      return { coverage: "poll-only", targets: [] };
    },
    async planReview(snapshot, id) {
      return {
        cwd: snapshot.worktree.path,
        input: { kind: "vcs", staged: id === "staged", options: {} },
      };
    },
    async prepareReview(input, cwd) {
      const bootstrap = createTestVcsAppBootstrap({
        files: [
          createTestDiffFile({ id: "alpha.ts", path: "alpha.ts" }),
          createTestDiffFile({ id: "beta.ts", path: "beta.ts" }),
        ],
      });
      bootstrap.input = { ...input, options: { ...runtime.launchOptions, ...input.options } };
      bootstrap.reloadContext.cwd = cwd;
      bootstrap.extensions = runtime.extensionSession.current;
      bootstrap.customThemes = runtime.initialization.theme.customThemes;
      return { ...bootstrap, extensions: runtime.extensionSession.current };
    },
    async prepareHistoryReview(action, cwd, signal) {
      return runtime.prepareReview(
        {
          kind: "show",
          ref: action.kind === "revision-show" ? action.revisionId : action.toRevisionId,
          options: {},
        },
        cwd,
        signal,
      );
    },
    async openHistory(path) {
      const source = {
        async read() {
          return {
            commits: [
              {
                revisionId: "status-commit",
                displayId: "commit",
                parentRevisionIds: [],
                subject: "Status history commit",
                authorName: "Ada",
                authoredAt: "2026-01-01T00:00:00Z",
                decorations: [],
              },
            ],
            done: true,
          };
        },
        async close() {},
      };
      return {
        input: {
          kind: "history",
          static: false,
          color: "always",
          format: "medium",
          ascii: false,
          extensionsEnabled: false,
          extensionPaths: [],
        },
        source,
        providerId: "test",
        providerName: "Test",
        startupCwd: runtime.startupCwd,
        repoRoot: path,
        extensionSession: runtime.extensionSession,
        notices: [],
        customThemes: runtime.initialization.theme.customThemes,
        initialization: runtime.initialization,
        initialViewPreferences: preferences,
        keybindings: {},
        promptSaveViewPreferences: false,
        async planReview(commit) {
          return { kind: "revision-show", revisionId: commit.revisionId };
        },
        async reopenSource() {
          return source;
        },
        async close() {
          await source.close();
        },
      };
    },
    async close() {},
  };
  return runtime;
}
