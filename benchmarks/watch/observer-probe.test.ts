import { describe, expect, test } from "bun:test";
import { selectedObserverBackend } from "./observer-probe";
import type { WatchPlan } from "../../src/core/watchPlan";

const plan: WatchPlan = {
  coverage: "hybrid",
  targets: [
    {
      kind: "directory-tree",
      directory: process.cwd(),
      ignoredRoots: [],
      sources: ["worktree"],
    },
  ],
};

describe("watch observer probe backend injection", () => {
  test("reports forced native and portable backends distinctly", () => {
    expect(selectedObserverBackend(plan, "native")).toBe("native-recursive");
    expect(selectedObserverBackend(plan, "chokidar")).toBe("chokidar-portable");
  });
});
