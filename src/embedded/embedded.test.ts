import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedHunkSession, embeddedSourceToCliInput } from "./index";

const patchText = [
  "diff --git a/example.ts b/example.ts",
  "--- a/example.ts",
  "+++ b/example.ts",
  "@@ -1 +1 @@",
  "-const value = 1;",
  "+const value = 2;",
  "",
].join("\n");

describe("embeddedSourceToCliInput", () => {
  test("maps embedded review sources to Hunk CLI inputs", () => {
    expect(embeddedSourceToCliInput({ kind: "worktree", options: { theme: "midnight" } })).toEqual({
      kind: "vcs",
      staged: false,
      options: { theme: "midnight" },
    });
    expect(embeddedSourceToCliInput({ kind: "staged" })).toEqual({
      kind: "vcs",
      staged: true,
      options: {},
    });
    expect(embeddedSourceToCliInput({ kind: "show", ref: "HEAD~1" })).toEqual({
      kind: "show",
      ref: "HEAD~1",
      options: {},
    });
    expect(
      embeddedSourceToCliInput({
        kind: "vcs",
        range: "main",
        staged: false,
        pathspecs: ["src/app.ts"],
        options: { vcs: "jj" },
      }),
    ).toEqual({
      kind: "vcs",
      range: "main",
      staged: false,
      pathspecs: ["src/app.ts"],
      options: { vcs: "jj" },
    });
    expect(
      embeddedSourceToCliInput({ kind: "diff", left: "before.ts", right: "after.ts" }),
    ).toEqual({
      kind: "diff",
      left: "before.ts",
      right: "after.ts",
      options: {},
    });
    expect(embeddedSourceToCliInput({ kind: "stash-show", ref: "stash@{1}" })).toEqual({
      kind: "stash-show",
      ref: "stash@{1}",
      options: {},
    });
    expect(embeddedSourceToCliInput({ kind: "patch", file: "changes.patch" })).toEqual({
      kind: "patch",
      file: "changes.patch",
      options: {},
    });
    expect(
      embeddedSourceToCliInput({
        kind: "difftool",
        left: "left.ts",
        right: "right.ts",
        path: "src/app.ts",
      }),
    ).toEqual({
      kind: "difftool",
      left: "left.ts",
      right: "right.ts",
      path: "src/app.ts",
      options: {},
    });
  });

  test("loads embedded sessions through Hunk config resolution", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-embedded-config-"));
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;

    try {
      const configHome = join(root, "config");
      mkdirSync(join(configHome, "hunk"), { recursive: true });
      writeFileSync(
        join(configHome, "hunk", "config.toml"),
        ['theme = "midnight"', 'mode = "stack"', "line_numbers = false"].join("\n"),
      );
      process.env.XDG_CONFIG_HOME = configHome;

      const session = await createEmbeddedHunkSession({
        cwd: root,
        source: { kind: "patch", text: patchText, options: { theme: "paper" } },
      });
      const snapshot = session.getSnapshot();

      expect(snapshot.status).toBe("ready");
      if (snapshot.status !== "ready") throw new Error("Expected embedded session to load.");
      expect(snapshot.bootstrap.initialMode).toBe("stack");
      expect(snapshot.bootstrap.initialShowLineNumbers).toBe(false);
      expect(snapshot.bootstrap.initialTheme).toBe("paper");

      session.dispose();
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("keeps the previous source and reports errors when reload fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-embedded-reload-error-"));

    try {
      const initialSource = { kind: "patch", text: patchText, label: "initial patch" } as const;
      const session = await createEmbeddedHunkSession({
        cwd: root,
        source: initialSource,
      });

      await expect(session.load({ kind: "patch", file: "missing.patch" })).rejects.toThrow();

      expect(session.source).toEqual(initialSource);
      const snapshot = session.getSnapshot();
      expect(snapshot.status).toBe("error");
      expect(snapshot.bootstrap).toBeDefined();

      session.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
