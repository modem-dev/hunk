import { describe, expect, test } from "bun:test";
import type {
  ExtensionVcsStatusReviewInput,
  ExtensionVcsStatusSnapshot,
  ExtensionVcsStatusWorktreeSummary,
} from "../extension-api/index";
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

/** Create a same-repository sibling with explicit ready facts. */
function createTestSibling(id = "sibling", path = id): ExtensionVcsStatusWorktreeSummary {
  return {
    worktree: { id, path, repositoryId: "test-repository" },
    bare: false,
    detached: false,
    inspectable: true,
    status: {
      state: "ready",
      observedAt: "2026-01-02T03:04:05.000Z",
      changedPathCount: 0,
      conflictCount: 0,
      operations: { state: "ready", value: [] },
    },
  };
}

/** Fail if validation touches any element before rejecting the collection's length. */
function createTestPoisonedArray(length: number): unknown[] {
  const values: unknown[] = [];
  values.length = length;
  Object.defineProperty(values, 0, {
    get() {
      throw new Error("Array element was traversed before preflight.");
    },
  });
  return values;
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

  test("copies normalized facts and rejects inconsistent or duplicate paths", () => {
    const original = createTestStatusSnapshot();
    original.paths = [{ path: "literal\t\n雪", worktree: "modified", conflict: false }];
    original.changedPathCount = 1;
    const normalized = normalizeVcsStatusSnapshot(original);
    original.head = { kind: "unborn", name: "changed" };
    original.paths[0]!.path = "changed";
    expect(normalized.head.kind).toBe("branch");
    expect(normalized.paths[0]!.path).toBe("literal\t\n雪");
    expect(() => normalizeVcsStatusSnapshot({ ...normalized, changedPathCount: 0 })).toThrow(
      "unique changed paths",
    );
    expect(() =>
      normalizeVcsStatusSnapshot({
        ...normalized,
        changedPathCount: 2,
        paths: [normalized.paths[0], normalized.paths[0]],
      }),
    ).toThrow("unique changed paths");
  });

  test("accepts the changed-path collection limit", () => {
    const current = createTestStatusSnapshot();
    current.paths = Array.from({ length: 20_000 }, (_, index) => ({
      path: `file-${index}`,
      worktree: "modified",
      conflict: false,
    }));
    current.changedPathCount = current.paths.length;
    expect(normalizeVcsStatusSnapshot(current).paths).toHaveLength(20_000);
  });

  test("rejects late cancelled provider results", async () => {
    const controller = new AbortController();
    const late = toInternalVcsStatus({
      ...createTestStatusCapability(),
      async read() {
        controller.abort(new Error("late status"));
        return createTestStatusSnapshot();
      },
    })!;
    await expect(late.read({}, { cwd: "workspace", signal: controller.signal })).rejects.toThrow(
      "late status",
    );
  });

  test("accepts working-copy actions without an index and rejects opaque or duplicate ids", async () => {
    const current = createTestStatusSnapshot();
    current.paths = [{ path: "file", worktree: "modified", conflict: false }];
    current.changedPathCount = 1;
    current.reviewActions = [{ id: "unstaged", label: "Working copy changes" }];
    const capability = toInternalVcsStatus(createTestStatusCapability())!;
    expect((await capability.planReview(current, "unstaged", { cwd: "workspace" })).input).toEqual({
      kind: "vcs",
      staged: false,
      options: {},
    });
    expect(normalizeVcsStatusSnapshot(current).paths[0]).not.toHaveProperty("index");
    await expect(capability.planReview(current, "other", { cwd: "workspace" })).rejects.toThrow(
      "Unknown status review action",
    );
    expect(() =>
      normalizeVcsStatusSnapshot({
        ...current,
        reviewActions: [{ id: "working", label: "Custom" }],
      }),
    ).toThrow();
    expect(() =>
      normalizeVcsStatusSnapshot({
        ...current,
        reviewActions: [...current.reviewActions, ...current.reviewActions],
      }),
    ).toThrow("action ids must be unique");
  });

  test("retains the inspected target and the action's staged semantics", async () => {
    const current = createTestStatusSnapshot();
    current.reviewActions = [{ id: "staged", label: "Index changes" }];
    const mismatched = toInternalVcsStatus(createTestStatusCapability())!;
    await expect(mismatched.planReview(current, "staged", { cwd: "workspace" })).rejects.toThrow(
      "staged/unstaged action",
    );
    const staged = toInternalVcsStatus({
      ...createTestStatusCapability(),
      async planReview() {
        return { cwd: "workspace", input: { kind: "vcs", staged: true, options: {} } };
      },
    })!;
    expect((await staged.planReview(current, "staged", { cwd: "workspace" })).input.staged).toBe(
      true,
    );

    current.reviewActions = [{ id: "unstaged", label: "Working changes" }];
    const foreign = toInternalVcsStatus({
      ...createTestStatusCapability(),
      async planReview(snapshot: typeof current) {
        // A provider cannot redefine the retained target by mutating its detached input.
        snapshot.worktree.path = "foreign";
        return { cwd: "foreign", input: { kind: "vcs", staged: false, options: {} } };
      },
    })!;
    await expect(foreign.planReview(current, "unstaged", { cwd: "workspace" })).rejects.toThrow(
      "inspected target",
    );
    expect(current.worktree.path).toBe("workspace");
  });

  test("rejects pathspec fields explicitly, including empty and undefined fields", async () => {
    const current = createTestStatusSnapshot();
    current.reviewActions = [{ id: "unstaged", label: "Working changes" }];
    for (const pathspecs of [["selected-file"], [], undefined, createTestPoisonedArray(20_001)]) {
      const capability = toInternalVcsStatus({
        ...createTestStatusCapability(),
        async planReview() {
          return {
            cwd: "workspace",
            input: { kind: "vcs", staged: false, pathspecs, options: {} },
          };
        },
      })!;
      await expect(
        capability.planReview(current, "unstaged", { cwd: "workspace" }),
      ).rejects.toThrow("must not include pathspecs");
    }
  });

  test("preserves comparison variants and rejects conflicting comparison inputs", async () => {
    const current = createTestStatusSnapshot();
    current.reviewActions = [{ id: "unstaged", label: "Working changes" }];
    for (const comparison of [
      { range: "base" },
      { rangeEndpoints: { from: "base", to: "working" } },
    ]) {
      const capability = toInternalVcsStatus({
        ...createTestStatusCapability(),
        async planReview() {
          return {
            cwd: "workspace",
            input: { kind: "vcs", staged: false, ...comparison, options: {} },
          };
        },
      })!;
      expect(
        (await capability.planReview(current, "unstaged", { cwd: "workspace" })).input,
      ).toEqual({
        kind: "vcs",
        staged: false,
        ...comparison,
        options: {},
      });
    }
    const conflict = toInternalVcsStatus({
      ...createTestStatusCapability(),
      async planReview() {
        return {
          cwd: "workspace",
          input: {
            kind: "vcs",
            staged: false,
            range: "base",
            rangeEndpoints: { from: "base", to: "working" },
            options: {},
          },
        };
      },
    })!;
    await expect(conflict.planReview(current, "unstaged", { cwd: "workspace" })).rejects.toThrow(
      "one comparison",
    );
  });

  test("exports a pathspec-free input type preserving exclusive comparisons", () => {
    const valid: ExtensionVcsStatusReviewInput = {
      kind: "vcs",
      staged: false,
      rangeEndpoints: { from: "base", to: "working" },
      options: {},
    };
    const invalidPathspec: ExtensionVcsStatusReviewInput = {
      kind: "vcs",
      staged: false,
      options: {},
      // @ts-expect-error Status plans cannot narrow the full comparison.
      pathspecs: [],
    };
    // @ts-expect-error Status plans retain the diff input's exclusive comparison union.
    const invalidComparison: ExtensionVcsStatusReviewInput = {
      kind: "vcs",
      staged: false,
      range: "base",
      rangeEndpoints: { from: "base", to: "working" },
      options: {},
    };
    const invalidAction: ExtensionVcsStatusSnapshot["reviewActions"][number] = {
      // @ts-expect-error The host supports semantic comparison ids, not arbitrary actions.
      id: "working",
      label: "Working copy",
    };
    expect(String(invalidAction.id)).toBe("working");
    expect(valid).not.toHaveProperty("pathspecs");
    expect(invalidPathspec).toHaveProperty("pathspecs", []);
    expect(invalidComparison.range).toBe("base");
  });
});

describe("status sibling identities", () => {
  for (const [name, rows, message] of [
    [
      "duplicate ids",
      [createTestSibling("same", "one"), createTestSibling("same", "two")],
      "ids and paths must be unique",
    ],
    [
      "duplicate paths",
      [createTestSibling("one", "same"), createTestSibling("two", "same")],
      "ids and paths must be unique",
    ],
    [
      "foreign repositories",
      [
        {
          ...createTestSibling(),
          worktree: { id: "other", path: "other", repositoryId: "foreign" },
        },
      ],
      "inspected repository",
    ],
    ["current id at another path", [createTestSibling("workspace", "other")], "worktree identity"],
    [
      "current path with another id",
      [createTestSibling("other", "workspace")],
      "worktree identity",
    ],
  ] as const) {
    test(`rejects ${name} in embedded facts and readSiblings`, async () => {
      const current = createTestStatusSnapshot();
      const result = { worktrees: [...rows], truncated: false };
      expect(() =>
        normalizeVcsStatusSnapshot({ ...current, siblings: { state: "ready", value: result } }),
      ).toThrow(message);
      const capability = toInternalVcsStatus({
        ...createTestStatusCapability(),
        async readSiblings() {
          return result;
        },
      })!;
      await expect(capability.readSiblings(current, { cwd: "workspace" })).rejects.toThrow(message);
    });
  }

  test("accepts matching current rows and detaches valid sibling facts", async () => {
    const current = createTestStatusSnapshot();
    const result = {
      worktrees: [createTestSibling("workspace"), createTestSibling()],
      truncated: true,
    };
    current.siblings = { state: "ready", value: result };
    const normalized = normalizeVcsStatusSnapshot(current);
    const capability = toInternalVcsStatus({
      ...createTestStatusCapability(),
      async readSiblings() {
        return result;
      },
    })!;
    const siblings = await capability.readSiblings(current, { cwd: "workspace" });
    result.worktrees[1]!.worktree.path = "mutated";
    expect(siblings.worktrees[1]!.worktree.path).toBe("sibling");
    expect(normalized.siblings).toEqual({ state: "ready", value: siblings });
  });

  test("checks repository membership against the retained identity, not provider mutation", async () => {
    const current = createTestStatusSnapshot();
    const capability = toInternalVcsStatus({
      ...createTestStatusCapability(),
      async readSiblings(snapshot: typeof current) {
        snapshot.worktree.repositoryId = "foreign";
        const row = createTestSibling();
        row.worktree.repositoryId = "foreign";
        return { worktrees: [row], truncated: false };
      },
    })!;
    await expect(capability.readSiblings(current, { cwd: "workspace" })).rejects.toThrow(
      "inspected repository",
    );
    expect(current.worktree.repositoryId).toBe("test-repository");
  });
});

describe("status aggregate text budget", () => {
  test("rejects individually valid Unicode path strings that exceed the result budget", () => {
    const current = createTestStatusSnapshot();
    current.paths = Array.from({ length: 43 }, (_, index) => ({
      path: `${index}-${"雪".repeat(65_530)}`,
      worktree: "modified",
      conflict: false,
    }));
    current.changedPathCount = current.paths.length;
    expect(() => normalizeVcsStatusSnapshot(current)).toThrow("result text exceeds");

    current.paths = current.paths.slice(0, 40);
    current.changedPathCount = current.paths.length;
    expect(normalizeVcsStatusSnapshot(current).paths).toHaveLength(40);
  });

  test("bounds sibling and watch text independently of allowed collection sizes", async () => {
    const message = "雪".repeat(65_530);
    const capability = toInternalVcsStatus({
      ...createTestStatusCapability(),
      async readSiblings() {
        return {
          truncated: false,
          worktrees: Array.from({ length: 43 }, (_, index) => ({
            ...createTestSibling(`sibling-${index}`),
            status: { state: "error", message },
          })),
        };
      },
      async watchPlan() {
        return {
          coverage: "hybrid",
          targets: [
            {
              kind: "directory-entries",
              directory: "workspace",
              sources: ["worktree"],
              entries: Array.from({ length: 43 }, (_, index) => `${index}-${message}`),
            },
          ],
        };
      },
    })!;
    const current = createTestStatusSnapshot();
    const context = { cwd: "workspace" };
    await expect(capability.readSiblings(current, context)).rejects.toThrow("result text exceeds");
    await expect(capability.watchPlan!(current, context)).rejects.toThrow("result text exceeds");
  });
});

describe("status collection preflight", () => {
  test("rejects oversized current collections without reading their elements", () => {
    const current = createTestStatusSnapshot();
    for (const [field, length, message] of [
      ["paths", 20_001, "paths exceeds 20000"],
      ["reviewActions", 33, "review actions exceeds 32"],
    ] as const) {
      expect(() =>
        normalizeVcsStatusSnapshot({ ...current, [field]: createTestPoisonedArray(length) }),
      ).toThrow(message);
    }
    expect(() =>
      normalizeVcsStatusSnapshot({
        ...current,
        operations: { state: "ready", value: createTestPoisonedArray(6) },
      }),
    ).toThrow("operations exceeds 5");
  });

  test("preflights sibling rows and nested operations for both publication paths", async () => {
    const current = createTestStatusSnapshot();
    const row = createTestSibling();
    for (const [value, message] of [
      [{ worktrees: createTestPoisonedArray(101), truncated: false }, "siblings exceeds 100"],
      [
        {
          worktrees: [
            {
              ...row,
              status: {
                ...row.status,
                operations: { state: "ready", value: createTestPoisonedArray(6) },
              },
            },
          ],
          truncated: false,
        },
        "operations exceeds 5",
      ],
    ] as const) {
      expect(() =>
        normalizeVcsStatusSnapshot({ ...current, siblings: { state: "ready", value } }),
      ).toThrow(message);
      const capability = toInternalVcsStatus({
        ...createTestStatusCapability(),
        async readSiblings() {
          return value;
        },
      })!;
      await expect(capability.readSiblings(current, { cwd: "workspace" })).rejects.toThrow(message);
    }
  });

  test("preflights watch targets, sources, roots and entries before schema traversal", async () => {
    const target = {
      kind: "directory-tree",
      directory: "workspace",
      ignoredRoots: [],
      sources: ["worktree"],
    };
    for (const [targets, message] of [
      [createTestPoisonedArray(257), "watch targets exceeds 256"],
      [[{ ...target, sources: createTestPoisonedArray(5) }], "watch sources exceeds 4"],
      [
        [{ ...target, ignoredRoots: createTestPoisonedArray(20_001) }],
        "watch ignored roots exceeds 20000",
      ],
      [
        [
          {
            kind: "directory-entries",
            directory: "workspace",
            entries: createTestPoisonedArray(20_001),
            sources: ["vcs-metadata"],
          },
        ],
        "watch entries exceeds 20000",
      ],
    ] as const) {
      const capability = toInternalVcsStatus({
        ...createTestStatusCapability(),
        async watchPlan() {
          return { coverage: "hybrid", targets };
        },
      })!;
      await expect(
        capability.watchPlan!(createTestStatusSnapshot(), { cwd: "workspace" }),
      ).rejects.toThrow(message);
    }
  });

  test("rejects aggregate watch amplification even when each nested array is allowed", async () => {
    const capability = toInternalVcsStatus({
      ...createTestStatusCapability(),
      async watchPlan() {
        return {
          coverage: "hybrid",
          targets: Array.from({ length: 3 }, (_, index) => ({
            kind: index === 0 ? "directory-tree" : "directory-entries",
            directory: `metadata-${index}`,
            ignoredRoots: createTestPoisonedArray(15_000),
            entries: createTestPoisonedArray(15_000),
            sources: ["vcs-metadata"],
          })),
        };
      },
    })!;
    await expect(
      capability.watchPlan!(createTestStatusSnapshot(), { cwd: "workspace" }),
    ).rejects.toThrow("40000 total entries");
  });

  test("accepts watch collections exactly at the aggregate budget and detaches them", async () => {
    const entries = Array(19_998).fill("metadata-entry");
    const targets = ["directory-tree", "directory-entries"].map((kind) => ({
      kind,
      directory: "workspace",
      ignoredRoots: entries,
      entries,
      sources: ["worktree"],
    }));
    const capability = toInternalVcsStatus({
      ...createTestStatusCapability(),
      async watchPlan() {
        return { coverage: "hybrid", targets };
      },
    })!;
    const result = await capability.watchPlan!(createTestStatusSnapshot(), { cwd: "workspace" });
    expect(result.targets).toHaveLength(2);
    entries[0] = "mutated";
    const first = result.targets[0]!;
    expect(first.kind).toBe("directory-tree");
    if (first.kind === "directory-tree") {
      expect(first.ignoredRoots).toHaveLength(19_998);
      expect(first.ignoredRoots[0]).toBe("metadata-entry");
    }
  });
});
