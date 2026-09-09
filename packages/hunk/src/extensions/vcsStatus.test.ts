import { describe, expect, test } from "bun:test";
import { createTestStatusSnapshot } from "../../../../test/helpers/vcsStatus";
import { normalizeVcsStatusSnapshot, toInternalVcsStatus } from "./vcsStatus";
import { toInternalVcsAdapter } from "./runExtension";

/** Create a capability that returns fresh status fixtures for boundary tests. */
function createTestStatusCapability() {
  return {
    async read() {
      return createTestStatusSnapshot();
    },
    async readSiblings() {
      return { worktrees: [], truncated: false };
    },
    async planReview() {
      return { cwd: "workspace", input: { kind: "vcs" as const, staged: false, options: {} } };
    },
  };
}

describe("extension status boundary", () => {
  test("remains optional and rejects malformed capabilities", () => {
    expect(toInternalVcsStatus(undefined)).toBeUndefined();
    expect(() => toInternalVcsStatus({ read() {} })).toThrow("readSiblings");
    expect(
      toInternalVcsAdapter({
        id: "test",
        name: "Test",
        detect: () => null,
        status: createTestStatusCapability(),
      }).status,
    ).toBeDefined();
  });
  test("copies normalized facts, rejects inconsistent counts and enforces collection limits", () => {
    const original = createTestStatusSnapshot();
    const normalized = normalizeVcsStatusSnapshot(original);
    original.head = { kind: "unborn", name: "changed" };
    expect(normalized.head.kind).toBe("branch");
    expect(() => normalizeVcsStatusSnapshot({ ...normalized, changedPathCount: 1 })).toThrow(
      "unique changed paths",
    );
    expect(() =>
      normalizeVcsStatusSnapshot({
        ...normalized,
        paths: Array(20_001).fill({ path: "x", worktree: "untracked", conflict: false }),
      }),
    ).toThrow();
  });
  test("rejects foreign siblings and late cancelled provider results", async () => {
    const provider = createTestStatusCapability();
    const current = createTestStatusSnapshot();
    const wrapped = toInternalVcsStatus({
      ...provider,
      async readSiblings() {
        return {
          worktrees: [
            {
              worktree: { id: "other", path: "other", repositoryId: "foreign" },
              bare: false,
              detached: false,
              inspectable: false,
              status: { state: "error", message: "unreadable" },
            },
          ],
          truncated: false,
        };
      },
    })!;
    await expect(wrapped.readSiblings(current, { cwd: "workspace" })).rejects.toThrow(
      "inspected repository",
    );
    const controller = new AbortController();
    const late = toInternalVcsStatus({
      ...provider,
      async read() {
        controller.abort(new Error("late status"));
        return current;
      },
    })!;
    await expect(late.read({}, { cwd: "workspace", signal: controller.signal })).rejects.toThrow(
      "late status",
    );
  });
  test("keeps full-comparison review targets and rejects unsupported actions", async () => {
    const current = createTestStatusSnapshot();
    current.reviewActions = [{ id: "working", label: "Working changes" }];
    const capability = toInternalVcsStatus(createTestStatusCapability())!;
    expect((await capability.planReview(current, "working", { cwd: "workspace" })).input).toEqual({
      kind: "vcs",
      staged: false,
      options: {},
    });
    await expect(capability.planReview(current, "other", { cwd: "workspace" })).rejects.toThrow(
      "Unknown status review action",
    );
    const foreign = toInternalVcsStatus({
      ...createTestStatusCapability(),
      async planReview() {
        return { cwd: "foreign", input: { kind: "vcs", staged: false, options: {} } };
      },
    })!;
    await expect(foreign.planReview(current, "working", { cwd: "workspace" })).rejects.toThrow(
      "inspected target",
    );
  });
});
