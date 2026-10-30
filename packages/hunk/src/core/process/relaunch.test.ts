import { describe, expect, test } from "bun:test";
import { resolveCurrentHunkCommand } from "./relaunch";

describe("current Hunk relaunch resolution", () => {
  test("keeps source and wrapper entrypoints", () => {
    expect(resolveCurrentHunkCommand(["bun", "/repo/src/main.tsx"], "/bin/bun")).toEqual({
      command: "/bin/bun",
      args: ["/repo/src/main.tsx"],
    });
    expect(resolveCurrentHunkCommand(["node", "C:\\pkg\\bin\\hunk.cjs"], "node.exe")).toEqual({
      command: "node.exe",
      args: ["C:\\pkg\\bin\\hunk.cjs"],
    });
  });

  test("uses the real executable for compiled Bun virtual paths", () => {
    expect(resolveCurrentHunkCommand(["bun", "/$bunfs/root/hunk"], "/usr/bin/hunk")).toEqual({
      command: "/usr/bin/hunk",
      args: [],
    });
    expect(resolveCurrentHunkCommand(["bun", "B:\\~BUN\\root\\hunk.exe"], "C:\\hunk.exe")).toEqual({
      command: "C:\\hunk.exe",
      args: [],
    });
  });
});
