import { describe, expect, test } from "bun:test";
import type { ExtensionVcsDiffInput, ExtensionVcsShowInput } from "hunkdiff/extension";
import {
  buildHgDiffArgs,
  buildHgEnvironment,
  buildHgShowArgs,
  buildHgUnknownArgs,
  createHgStagedError,
  hasWorkingCopyEndpoint,
  parseHgRange,
  parseHgUnknownPaths,
  translateHgExitFailure,
  translateHgSpawnFailure,
} from "./commands.js";

const diffInput = (overrides: Partial<ExtensionVcsDiffInput> = {}): ExtensionVcsDiffInput => ({
  kind: "vcs",
  staged: false,
  options: {},
  ...overrides,
});

const showInput = (overrides: Partial<ExtensionVcsShowInput> = {}): ExtensionVcsShowInput => ({
  kind: "show",
  options: {},
  ...overrides,
});

describe("Mercurial command construction", () => {
  test("uses deterministic diff flags and the narrow range policy", () => {
    expect(buildHgDiffArgs(diffInput())).toEqual(["diff", "--git", "--nodates"]);
    expect(buildHgDiffArgs(diffInput({ range: "base" }))).toEqual([
      "diff",
      "--git",
      "--nodates",
      "--rev",
      "base",
    ]);
    expect(buildHgDiffArgs(diffInput({ range: "base:tip" }))).toEqual([
      "diff",
      "--git",
      "--nodates",
      "--rev",
      "base",
      "--rev",
      "tip",
    ]);
    expect(
      buildHgDiffArgs(diffInput(), {
        kind: "revision-to-working-copy",
        revision: "pinned-node",
      }),
    ).toEqual(["diff", "--git", "--nodates", "--rev", "pinned-node"]);
    expect(parseHgRange()).toEqual({ kind: "working-copy" });
    expect(hasWorkingCopyEndpoint(diffInput({ range: "base" }))).toBe(true);
    expect(hasWorkingCopyEndpoint(diffInput({ range: "base:tip" }))).toBe(false);
  });

  test("rejects empty, open-ended, and multi-colon ranges", () => {
    for (const range of ["", ":tip", "base:", "a:b:c"]) {
      expect(() => parseHgRange(range)).toThrow("is not supported");
    }
  });

  test("passes pathspecs only as argv-safe path patterns", () => {
    const pathspecs = ["-r", "glob:**", "folder/a b.txt"];
    expect(buildHgDiffArgs(diffInput({ pathspecs }))).toEqual([
      "diff",
      "--git",
      "--nodates",
      "--",
      "path:-r",
      "path:glob:**",
      "path:folder/a b.txt",
    ]);
    expect(buildHgUnknownArgs(diffInput({ pathspecs }))).toEqual([
      "status",
      "--unknown",
      "--print0",
      "--",
      "path:-r",
      "path:glob:**",
      "path:folder/a b.txt",
    ]);
  });

  test("builds revision-show args with dot as the default", () => {
    expect(buildHgShowArgs(showInput())).toEqual(["diff", "--git", "--nodates", "--change", "."]);
    expect(buildHgShowArgs(showInput({ ref: "42", pathspecs: ["src/main.ts"] }))).toEqual([
      "diff",
      "--git",
      "--nodates",
      "--change",
      "42",
      "--",
      "path:src/main.ts",
    ]);
    expect(buildHgShowArgs(showInput({ ref: "bookmark" }), "pinned-node")).toEqual([
      "diff",
      "--git",
      "--nodates",
      "--change",
      "pinned-node",
    ]);
  });

  test("parses and sorts only unknown NUL-delimited status records", () => {
    expect(parseHgUnknownPaths("? z.txt\0M tracked.txt\0? a b.txt\0")).toEqual([
      "a b.txt",
      "z.txt",
    ]);
  });

  test("forces stable Mercurial output without dropping the caller environment", () => {
    const environment = buildHgEnvironment({ PATH: "test-path", HGPLAIN: "0" });
    expect(environment.PATH).toBe("test-path");
    expect(environment.HGPLAIN).toBe("1");
    expect(environment.HGENCODING).toBe("utf-8");
  });
});

describe("Mercurial user errors", () => {
  test("rejects staged reviews before spawning", () => {
    const error = createHgStagedError(diffInput({ staged: true }));
    expect(error.name).toBe("HunkExtensionUserError");
    expect(error.message).toContain("Mercurial has no staging area");
    expect(error.suggestions).toEqual(["Remove `--staged` to review the Mercurial working copy."]);
  });

  test("translates missing executable, non-repo, and invalid revision failures", () => {
    const missing = Object.assign(new Error("spawn hg ENOENT"), { code: "ENOENT" });
    expect(translateHgSpawnFailure(showInput(), missing, "hg-missing").message).toContain(
      "was not found in PATH",
    );
    expect(translateHgSpawnFailure(showInput(), new Error("resource limit"), "hg").name).toBe(
      "HunkExtensionUserError",
    );
    expect(
      translateHgExitFailure(diffInput(), "abort: no repository found in this directory").message,
    ).toContain("inside a Mercurial repository");
    expect(
      translateHgExitFailure(showInput({ ref: "missing" }), "abort: unknown revision 'missing'")
        .message,
    ).toContain("could not resolve Mercurial revision `missing`");
  });

  test("keeps generic failures concise and actionable", () => {
    const error = translateHgExitFailure(showInput(), "abort: permission denied\nmore detail");
    expect(error.name).toBe("HunkExtensionUserError");
    expect(error.message).toBe("`hunk show` failed.");
    expect("suggestions" in error ? error.suggestions : []).toEqual(["permission denied"]);
  });
});
