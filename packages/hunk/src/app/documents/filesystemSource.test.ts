import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devNull, tmpdir } from "node:os";
import {
  createFilesystemSource,
  DOCUMENT_MAX_BYTES,
  DIRECTORY_MAX_ENTRIES,
} from "./filesystemSource";

const roots: string[] = [];
/** Create one isolated filesystem collection. */
async function createTestRoot() {
  const root = await mkdtemp(join(tmpdir(), "hunk-documents-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("filesystem documents", () => {
  test("lists only immediate children, directories first, and reads complete unchanged text", async () => {
    const root = await createTestRoot();
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "child.txt"), "child");
    await writeFile(join(root, "README.md"), "# complete\nunchanged\n");
    await writeFile(join(root, ".hidden"), "hidden");
    const source = await createFilesystemSource(root);
    const listing = await source.list(source.root.key);
    expect(listing.kind).toBe("entries");
    if (listing.kind !== "entries") throw new Error(listing.detail);
    expect(listing.entries[0]?.name).toBe("nested");
    expect(listing.entries.some((entry) => entry.name === "child.txt")).toBe(false);
    expect(listing.entries.find((entry) => entry.name === ".hidden")?.hidden).toBe(true);
    const document = await source.read(join(root, "README.md"));
    expect(document.kind).toBe("text");
    if (document.kind === "text") expect(document.text).toBe("# complete\nunchanged\n");
  });
  test("refuses binary, invalid UTF-8, oversize, missing, special and escaping entries", async () => {
    const root = await createTestRoot();
    await writeFile(join(root, "binary"), Buffer.from([0, 1]));
    await writeFile(join(root, "encoding"), Buffer.from([255, 254]));
    await writeFile(join(root, "huge"), Buffer.alloc(DOCUMENT_MAX_BYTES + 1, 65));
    const source = await createFilesystemSource(root);
    expect(await source.read(join(root, "binary"))).toMatchObject({
      kind: "unavailable",
      reason: "binary",
    });
    expect(await source.read(join(root, "encoding"))).toMatchObject({
      kind: "unavailable",
      reason: "binary",
    });
    expect(await source.read(join(root, "huge"))).toMatchObject({
      kind: "unavailable",
      reason: "too-large",
    });
    expect(await source.read(join(root, "missing"))).toMatchObject({
      kind: "unavailable",
      reason: "missing",
    });
    expect(await source.read(root)).toMatchObject({ kind: "unavailable", reason: "special" });
    expect(await source.read(join(root, "..", "escape"))).toMatchObject({ kind: "unavailable" });
  });
  test.skipIf(process.platform === "win32")(
    "does not follow file or directory symlinks, even when opened explicitly",
    async () => {
      const root = await createTestRoot();
      const outside = await createTestRoot();
      await writeFile(join(outside, "secret"), "outside");
      await symlink(outside, join(root, "link"), "dir");
      await symlink(join(outside, "secret"), join(root, "file-link"));
      const source = await createFilesystemSource(root);
      expect(await source.read(join(root, "file-link"))).toMatchObject({
        kind: "unavailable",
        reason: "symlink",
      });
      expect(await source.list(join(root, "link"))).toMatchObject({ kind: "unavailable" });
      expect(await source.read(join(root, "link", "secret"))).toMatchObject({
        kind: "unavailable",
      });
      expect(await source.editablePath?.(join(root, "file-link"))).toBeNull();
      const direct = await createFilesystemSource(join(root, "file-link"));
      expect(direct.root.kind).toBe("symlink");
      expect(await direct.read(direct.root.key)).toMatchObject({ reason: "symlink" });
    },
  );
  test("honors Git ignore rules without hiding tracked files and reports statuses", async () => {
    const root = await createTestRoot();
    const runGit = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: root });
      expect(result.exitCode).toBe(0);
    };
    runGit("init", "--quiet");
    await writeFile(join(root, ".gitignore"), "*.log\nignored/\n");
    await writeFile(join(root, "tracked.log"), "tracked");
    runGit("add", "-f", "tracked.log");
    await writeFile(join(root, "ignored.log"), "ignored");
    await mkdir(join(root, "ignored"));
    const source = await createFilesystemSource(root);
    const listing = await source.list(root);
    if (listing.kind !== "entries") throw new Error(listing.detail);
    expect(listing.entries.find((entry) => entry.name === "ignored.log")?.ignored).toBe(true);
    expect(listing.entries.find((entry) => entry.name === "ignored")?.ignored).toBe(true);
    expect(listing.entries.find((entry) => entry.name === "tracked.log")?.ignored).toBe(false);
    expect(listing.entries.find((entry) => entry.name === "tracked.log")?.status).toBe("A");
  });
  test("metadata queries do not execute repository fsmonitor hooks or clean/process filters", async () => {
    const root = await createTestRoot();
    const marker = join(root, "executed");
    const script = join(root, "hook.mjs");
    await writeFile(
      script,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
    );
    const runGit = (...args: string[]) => {
      const result = Bun.spawnSync(
        ["git", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, ...args],
        { cwd: root },
      );
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    runGit("init", "--quiet");
    await writeFile(join(root, "tracked.txt"), "before");
    await writeFile(join(root, ".gitattributes"), "tracked.txt filter=unsafe\n");
    runGit("add", ".gitattributes", "tracked.txt");
    const command = `"${process.execPath}" "${script}"`;
    runGit("config", "core.fsmonitor", command);
    runGit("config", "filter.unsafe.clean", command);
    runGit("config", "filter.unsafe.process", command);
    runGit("config", "filter.unsafe.required", "true");
    await writeFile(join(root, "tracked.txt"), "after");
    // Submodule status must not execute filters declared only in that nested repository.
    const nested = join(root, "nested");
    await mkdir(nested);
    runGit("-C", nested, "init", "--quiet");
    await writeFile(join(nested, "file.txt"), "before");
    await writeFile(join(nested, ".gitattributes"), "file.txt filter=nestedUnsafe\n");
    runGit("-C", nested, "add", ".");
    runGit(
      "-C",
      nested,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    const revision = runGit("-C", nested, "rev-parse", "HEAD");
    runGit("update-index", "--add", "--cacheinfo", `160000,${revision},nested`);
    runGit("-C", nested, "config", "filter.nestedUnsafe.clean", command);
    runGit("-C", nested, "config", "filter.nestedUnsafe.required", "true");
    await writeFile(join(nested, "file.txt"), "after");
    const source = await createFilesystemSource(root);
    expect((await source.list(root)).kind).toBe("entries");
    expect(existsSync(marker)).toBe(false);
  });
  // Windows chmod does not revoke read access; root bypasses Unix permission modes.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "shows a placeholder for unreadable files",
    async () => {
      const root = await createTestRoot();
      const file = join(root, "unreadable");
      await writeFile(file, "private");
      await chmod(file, 0);
      try {
        const source = await createFilesystemSource(root);
        expect(await source.read(file)).toMatchObject({
          kind: "unavailable",
          reason: "unreadable",
        });
      } finally {
        await chmod(file, 0o600);
      }
    },
  );
  test("bounds directory enumeration and cancels reads", async () => {
    const root = await createTestRoot();
    await Promise.all(
      Array.from({ length: DIRECTORY_MAX_ENTRIES + 1 }, (_, index) =>
        mkdir(join(root, `entry-${index}`)),
      ),
    );
    const source = await createFilesystemSource(root);
    expect(await source.list(root)).toMatchObject({
      kind: "unavailable",
      detail: "Directory exceeds the 10,000-entry browsing limit.",
    });
    const abort = new AbortController();
    abort.abort();
    await expect(source.list(root, abort.signal)).rejects.toThrow();
    await expect(source.read(root, abort.signal)).rejects.toThrow();
  });
  test("observes atomic replacement and releases subscriptions", async () => {
    const root = await createTestRoot();
    const file = join(root, "selected.txt");
    await writeFile(file, "one");
    const source = await createFilesystemSource(root);
    let changes = 0;
    const stop = source.observe?.([file], () => changes++);
    const replacement = join(root, "replacement");
    await writeFile(replacement, "two");
    await rename(replacement, file);
    await Bun.sleep(350);
    expect(changes).toBeGreaterThan(0);
    stop?.();
    const before = changes;
    await writeFile(file, "three");
    await Bun.sleep(200);
    expect(changes).toBe(before);
  });
});
