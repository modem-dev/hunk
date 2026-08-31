import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createWorkingTreeSourcePathResolver } from "./workingTreeSource";

describe("createWorkingTreeSourcePathResolver", () => {
  const resolvePath = createWorkingTreeSourcePathResolver("/repo");
  const file = { path: "src/a.ts", changeType: "change", isUntracked: false } as const;

  test("resolves only present new sides", () => {
    expect(resolvePath({ ...file, side: "new" })).toBe(join("/repo", "src/a.ts"));
    expect(resolvePath({ ...file, side: "old" })).toBeNull();
    expect(resolvePath({ ...file, changeType: "deleted", side: "new" })).toBeNull();
  });
});
