import type { ExtensionVcsStatusSnapshot } from "../../packages/hunk/src/extension-api/types";

/** Create a small JSON-safe status snapshot for boundary, bootstrap and projection tests. */
export function createTestStatusSnapshot(path = "workspace"): ExtensionVcsStatusSnapshot {
  return {
    schemaVersion: 1,
    observedAt: "2026-01-02T03:04:05.000Z",
    worktree: { id: path, path, repositoryId: "test-repository" },
    token: "test-status-token",
    head: { kind: "branch", name: "main", revisionId: "a".repeat(40) },
    upstream: { state: "ready", value: { kind: "none" } },
    operations: { state: "ready", value: [] },
    paths: [],
    changedPathCount: 0,
    reviewActions: [],
    siblings: { state: "loading" },
  };
}
