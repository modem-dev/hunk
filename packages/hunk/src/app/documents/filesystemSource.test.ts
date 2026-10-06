import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  // Windows temp paths may use 8.3 aliases; source keys use canonical paths on every platform.
  const root = await realpath(await mkdtemp(join(tmpdir(), "hunk-documents-")));
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
      let launched = false;
      expect(
        await source.edit?.(join(root, "file-link"), async () => {
          launched = true;
          return null;
        }),
      ).toBe("No editable regular text file selected.");
      expect(launched).toBe(false);
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
  }, 30_000);

  test("edits a private copy, preserves BOM bytes, and saves through the original handle", async () => {
    const root = await createTestRoot();
    const file = join(root, "selected.txt");
    const original = Buffer.from("\ufeffbefore\n");
    await writeFile(file, original);
    const source = await createFilesystemSource(root);
    let copyPath = "";
    expect(
      await source.edit?.(file, async (copy) => {
        copyPath = copy;
        expect(copy).not.toBe(file);
        expect(await readFile(copy)).toEqual(original);
        return null;
      }),
    ).toBeNull();
    expect(await readFile(file)).toEqual(original);
    expect(existsSync(copyPath)).toBe(false);
    expect(
      await source.edit?.(file, async (copy) => {
        await writeFile(copy, "after\n");
        return null;
      }),
    ).toBeNull();
    expect(await readFile(file, "utf8")).toBe("after\n");
  });

  test("refuses editor writeback after attempted atomic replacement and retains the edited copy", async () => {
    const root = await createTestRoot();
    const file = join(root, "selected.txt");
    await writeFile(file, "before");
    const source = await createFilesystemSource(root);
    let copyPath = "";
    let replaced = false;
    const result = await source.edit?.(file, async (copy) => {
      copyPath = copy;
      await writeFile(copy, "edited");
      const replacement = join(root, "replacement");
      await writeFile(replacement, "replacement");
      // Windows Bun currently pins writable handles against rename (EPERM). A rejected
      // editor operation must still preserve its private copy and leave the original intact.
      await rename(replacement, file);
      replaced = true;
      return null;
    });
    // Register retained recovery directories for test cleanup as well.
    roots.push(join(copyPath, ".."));
    if (!replaced) expect(process.platform).toBe("win32");
    expect(result).toContain(replaced ? "Document changed while editing" : "EPERM");
    expect(result).toContain("Editor copy retained");
    expect(await readFile(file, "utf8")).toBe(replaced ? "replacement" : "before");
    expect(await readFile(copyPath, "utf8")).toBe("edited");
  });

  test("rejects concurrent in-place changes without overwriting either the original or editor copy", async () => {
    const root = await createTestRoot();
    const file = join(root, "selected.txt");
    await writeFile(file, "before");
    const source = await createFilesystemSource(root);
    let copyPath = "";
    const result = await source.edit?.(file, async (copy) => {
      copyPath = copy;
      await writeFile(copy, "edited");
      await writeFile(file, "concurrent");
      return null;
    });
    roots.push(join(copyPath, ".."));
    expect(result).toContain("Document changed while editing");
    expect(await readFile(file, "utf8")).toBe("concurrent");
    expect(await readFile(copyPath, "utf8")).toBe("edited");
  });

  test.skipIf(process.platform === "win32")(
    "never passes a collection path to the editor after a symlink swap",
    async () => {
      const root = await createTestRoot();
      const outside = await createTestRoot();
      const file = join(root, "selected.txt");
      const secret = join(outside, "secret.txt");
      await writeFile(file, "before");
      await writeFile(secret, "outside");
      const source = await createFilesystemSource(root);
      let copyPath = "";
      const result = await source.edit?.(file, async (copy) => {
        copyPath = copy;
        await rename(file, join(root, "original.txt"));
        await symlink(secret, file);
        await writeFile(copy, "edited");
        return null;
      });
      roots.push(join(copyPath, ".."));
      expect(result).toContain("Document changed while editing");
      expect(await readFile(secret, "utf8")).toBe("outside");
      expect(await readFile(join(root, "original.txt"), "utf8")).toBe("before");
    },
  );

  test.skipIf(process.platform !== "linux")(
    "binds enumeration to the checked directory during a swap and restore",
    async () => {
      const root = await createTestRoot();
      const outside = await createTestRoot();
      const directory = join(root, "nested");
      const retained = join(root, "retained");
      await mkdir(directory);
      await writeFile(join(directory, "inside.txt"), "inside");
      await writeFile(join(outside, "secret.txt"), "outside");
      const source = await createFilesystemSource(root, {
        async openDirectory(path) {
          await rename(directory, retained);
          await symlink(outside, directory, "dir");
          const opened = await opendir(path);
          await rm(directory);
          await rename(retained, directory);
          return opened;
        },
      });
      const listing = await source.list(directory);
      expect(listing.kind).toBe("entries");
      if (listing.kind === "entries")
        expect(listing.entries.map((entry) => entry.name)).toEqual(["inside.txt"]);
    },
  );

  test("rejects incomplete ignore output when the query times out or fails", async () => {
    const root = await createTestRoot();
    expect(Bun.spawnSync(["git", "init", "--quiet"], { cwd: root }).exitCode).toBe(0);
    await writeFile(join(root, "ignored.log"), "ignored");
    await writeFile(join(root, "another.log"), "ignored");
    for (const script of [
      'process.stdout.write("partial\\0"); setTimeout(() => {}, 10000);',
      'process.stdout.write("partial\\0"); process.exit(2);',
    ]) {
      const source = await createFilesystemSource(root, {
        spawn: ((...args: Parameters<typeof Bun.spawn>) => {
          const [command, options] = args;
          if (Array.isArray(command) && command.includes("check-ignore"))
            return Bun.spawn([process.execPath, "-e", script], options);
          throw new Error("Unexpected subprocess.");
        }) as typeof Bun.spawn,
      });
      expect(await source.list(root)).toMatchObject({
        kind: "unavailable",
        detail: "Git ignore query did not complete; refresh to retry.",
      });
    }
  });

  test("cancels an in-flight ignore query instead of returning a partial directory", async () => {
    const root = await createTestRoot();
    expect(Bun.spawnSync(["git", "init", "--quiet"], { cwd: root }).exitCode).toBe(0);
    await writeFile(join(root, "ignored.log"), "ignored");
    const abort = new AbortController();
    let launched = false;
    const source = await createFilesystemSource(root, {
      spawn: ((...args: Parameters<typeof Bun.spawn>) => {
        const [, options] = args;
        launched = true;
        const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 10000);"], options);
        setTimeout(() => abort.abort(), 50);
        return child;
      }) as typeof Bun.spawn,
    });
    await expect(source.list(root, abort.signal)).rejects.toThrow();
    expect(launched).toBe(true);
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
