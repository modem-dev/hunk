import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AppBootstrap, CliInput } from "../core/types";
import { createSessionReloadBounds, validateSessionReloadWithinBounds } from "./sessionFileBounds";

/** Resolve expected paths the same way production bounds do, including Windows long names. */
function realPath(path: string) {
  return realpathSync.native(resolve(path));
}

function bootstrapFor(input: CliInput, sourceLabel: string): AppBootstrap {
  return {
    input,
    changeset: {
      id: "changeset:test",
      sourceLabel,
      title: "test changeset",
      files: [],
    },
    initialMode: "split",
  };
}

describe("session reload filesystem bounds", () => {
  test("allows VCS reloads inside the initial repo root", () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-repo-"));
    const nested = join(dir, "src");
    mkdirSync(nested);

    try {
      const bounds = createSessionReloadBounds(
        bootstrapFor({ kind: "vcs", staged: false, options: {} }, dir),
        { cwd: nested },
      );

      expect(
        validateSessionReloadWithinBounds(bounds, {
          kind: "show",
          ref: "HEAD",
          options: {},
        }).cwd,
      ).toBe(realPath(nested));
      expect(
        validateSessionReloadWithinBounds(
          bounds,
          {
            kind: "vcs",
            staged: false,
            options: {},
          },
          { sourcePath: dir },
        ).cwd,
      ).toBe(realPath(dir));
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("rejects daemon reload source paths outside the initial repo root", () => {
    const repo = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-repo-"));
    const outside = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-outside-"));

    try {
      const bounds = createSessionReloadBounds(
        bootstrapFor({ kind: "vcs", staged: false, options: {} }, repo),
        { cwd: repo },
      );

      expect(() =>
        validateSessionReloadWithinBounds(
          bounds,
          {
            kind: "vcs",
            staged: false,
            options: {},
          },
          { sourcePath: outside },
        ),
      ).toThrow("source path outside the initial Hunk root");
      expect(() =>
        validateSessionReloadWithinBounds(
          bounds,
          {
            kind: "vcs",
            staged: false,
            options: {},
          },
          { sourcePath: ".." },
        ),
      ).toThrow("source path outside the initial Hunk root");
    } finally {
      rmSync(repo, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  test("allows reloads from subdirectories inside the initial repo root", () => {
    const repo = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-subdir-"));
    const nested = join(repo, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const left = join(nested, "before.ts");
    const right = join(nested, "after.ts");
    writeFileSync(left, "before\n");
    writeFileSync(right, "after\n");

    try {
      const bounds = createSessionReloadBounds(
        bootstrapFor({ kind: "vcs", staged: false, options: {} }, repo),
        { cwd: repo },
      );

      expect(
        validateSessionReloadWithinBounds(
          bounds,
          {
            kind: "diff",
            left: "before.ts",
            right: "after.ts",
            options: {},
          },
          { sourcePath: nested },
        ).cwd,
      ).toBe(realPath(nested));
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  test("rejects direct file reloads launched outside a repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-files-"));
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    writeFileSync(left, "before\n");
    writeFileSync(right, "after\n");

    try {
      const bounds = createSessionReloadBounds(
        bootstrapFor({ kind: "diff", left, right, options: {} }, "file compare"),
        { cwd: dir },
      );

      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "diff",
          left,
          right,
          options: {},
        }),
      ).toThrow("rooted in a repository");
      expect(() =>
        validateSessionReloadWithinBounds(
          bounds,
          {
            kind: "diff",
            left,
            right,
            options: {},
          },
          { sourcePath: resolve(dir, "..") },
        ),
      ).toThrow("rooted in a repository");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("uses the repo root for direct file sessions launched inside a repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-file-repo-"));
    const nested = join(repo, "src");
    mkdirSync(join(repo, ".git"));
    mkdirSync(nested);
    const left = join(nested, "before.ts");
    const right = join(nested, "after.ts");
    const other = join(repo, "other.ts");
    writeFileSync(left, "before\n");
    writeFileSync(right, "after\n");
    writeFileSync(other, "other\n");

    try {
      const bounds = createSessionReloadBounds(
        bootstrapFor({ kind: "diff", left, right, options: {} }, "file compare"),
        { cwd: repo },
      );

      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "show",
          ref: "HEAD",
          options: {},
        }),
      ).not.toThrow();
      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "diff",
          left,
          right: other,
          options: {},
        }),
      ).not.toThrow();
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  test("rejects symlink escapes from the initial root", () => {
    const repo = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-link-repo-"));
    const outside = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-link-outside-"));
    const safe = join(repo, "safe.ts");
    const secret = join(outside, "secret.ts");
    const link = join(repo, "outside-link");
    writeFileSync(safe, "safe\n");
    writeFileSync(secret, "secret\n");

    try {
      try {
        symlinkSync(outside, link, "dir");
      } catch {
        // Some Windows environments cannot create symlinks without elevated privileges.
        return;
      }

      const bounds = createSessionReloadBounds(
        bootstrapFor({ kind: "vcs", staged: false, options: {} }, repo),
        { cwd: repo },
      );

      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "diff",
          left: join(link, "secret.ts"),
          right: safe,
          options: {},
        }),
      ).toThrow("left file outside the initial Hunk root");
      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "diff",
          left: join(link, "missing-until-after-validation.ts"),
          right: safe,
          options: {},
        }),
      ).toThrow("left file outside the initial Hunk root");
    } finally {
      rmSync(repo, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  test("uses the repo root for patch-file sessions launched inside a repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-patch-file-repo-"));
    const outside = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-patch-file-outside-"));
    mkdirSync(join(repo, ".git"));
    const patch = join(repo, "changes.patch");
    const otherPatch = join(repo, "other.patch");
    const outsidePatch = join(outside, "secret.patch");
    writeFileSync(patch, "diff --git a/a b/a\n");
    writeFileSync(otherPatch, "diff --git a/b b/b\n");
    writeFileSync(outsidePatch, "diff --git a/secret b/secret\n");

    try {
      const bounds = createSessionReloadBounds(
        bootstrapFor({ kind: "patch", file: patch, options: {} }, "patch file"),
        { cwd: repo },
      );

      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "patch",
          file: otherPatch,
          options: {},
        }),
      ).not.toThrow();
      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "patch",
          file: outsidePatch,
          options: {},
        }),
      ).toThrow("patch file outside the initial Hunk root");
    } finally {
      rmSync(repo, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  test("rejects patch-file reloads launched outside a repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-patch-file-"));
    const patch = join(dir, "changes.patch");
    writeFileSync(patch, "diff --git a/a b/a\n");

    try {
      const bounds = createSessionReloadBounds(
        bootstrapFor({ kind: "patch", file: patch, options: {} }, "patch file"),
        { cwd: dir },
      );

      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "patch",
          file: patch,
          options: {},
        }),
      ).toThrow("rooted in a repository");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("rejects patch and difftool file inputs outside the initial root", () => {
    const repo = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-patch-repo-"));
    const outside = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-patch-outside-"));
    const safe = join(repo, "safe.ts");
    const patch = join(outside, "secret.patch");
    const secretLeft = join(outside, "before.ts");
    const secretRight = join(outside, "after.ts");
    writeFileSync(safe, "safe\n");
    writeFileSync(patch, "diff --git a/a b/a\n");
    writeFileSync(secretLeft, "before\n");
    writeFileSync(secretRight, "after\n");

    try {
      const bounds = createSessionReloadBounds(
        bootstrapFor({ kind: "vcs", staged: false, options: {} }, repo),
        { cwd: repo },
      );

      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "patch",
          file: patch,
          options: {},
        }),
      ).toThrow("patch file outside the initial Hunk root");
      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "difftool",
          left: secretLeft,
          right: safe,
          path: "safe.ts",
          options: {},
        }),
      ).toThrow("left file outside the initial Hunk root");
      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "difftool",
          left: safe,
          right: secretRight,
          path: "safe.ts",
          options: {},
        }),
      ).toThrow("right file outside the initial Hunk root");
    } finally {
      rmSync(repo, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  test("rejects agent context sidecars outside the initial root", () => {
    const repo = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-agent-repo-"));
    const outside = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-agent-secret-"));
    const sidecar = join(outside, "notes.json");
    writeFileSync(sidecar, '{"version":1,"files":[]}\n');

    try {
      const bounds = createSessionReloadBounds(
        bootstrapFor({ kind: "vcs", staged: false, options: {} }, repo),
        { cwd: repo },
      );

      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "vcs",
          staged: false,
          options: { agentContext: sidecar },
        }),
      ).toThrow("agent context path outside the initial Hunk root");
    } finally {
      rmSync(repo, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  test("rejects agent context sidecars that escape through symlinks", () => {
    const repo = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-agent-link-repo-"));
    const outside = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-agent-link-outside-"));
    const sidecar = join(outside, "notes.json");
    const link = join(repo, "agent-link");
    writeFileSync(sidecar, '{"version":1,"files":[]}\n');

    try {
      try {
        symlinkSync(outside, link, "dir");
      } catch {
        // Some Windows environments cannot create symlinks without elevated privileges.
        return;
      }

      const bounds = createSessionReloadBounds(
        bootstrapFor({ kind: "vcs", staged: false, options: {} }, repo),
        { cwd: repo },
      );

      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "vcs",
          staged: false,
          options: { agentContext: join(link, "notes.json") },
        }),
      ).toThrow("agent context path outside the initial Hunk root");
    } finally {
      rmSync(repo, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  test("rejects stdin-backed patch and agent context reload inputs", () => {
    const repo = mkdtempSync(join(tmpdir(), "hunk-reload-bounds-stdin-"));

    try {
      const bounds = createSessionReloadBounds(
        bootstrapFor({ kind: "vcs", staged: false, options: {} }, repo),
        { cwd: repo },
      );

      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "patch",
          file: "-",
          options: {},
        }),
      ).toThrow("stdin-backed patch input");
      expect(() =>
        validateSessionReloadWithinBounds(bounds, {
          kind: "vcs",
          staged: false,
          options: { agentContext: "-" },
        }),
      ).toThrow("--agent-context -");
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });
});
