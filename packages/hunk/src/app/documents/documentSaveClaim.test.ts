import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDeferred } from "../../../../../test/helpers/diff-helpers";
import { withDocumentSaveClaim } from "./documentSaveClaim";

const roots: string[] = [];
const identity = { dev: 1, ino: 42 };

/** Create an account-private namespace independent of production coordination files. */
async function createTestClaimDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "hunk-save-claims-test-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a live reservation rejects the same inode while allowing unrelated documents", async () => {
  const directory = await createTestClaimDirectory();
  const started = createTestDeferred<void>();
  const release = createTestDeferred<void>();
  const first = withDocumentSaveClaim(
    identity,
    async () => {
      started.resolve();
      await release.promise;
    },
    { directory },
  );

  try {
    await started.promise;
    await expect(
      withDocumentSaveClaim(
        identity,
        async () => {
          throw new Error("Must not save");
        },
        { directory },
      ),
    ).rejects.toThrow("Another Hunk session is saving");
    expect(await readdir(directory)).toHaveLength(1);
    expect(
      await withDocumentSaveClaim({ dev: 1, ino: 43 }, async () => "saved", { directory }),
    ).toBe("saved");
  } finally {
    release.resolve();
    await first;
  }
  expect(await readdir(directory)).toEqual([]);
});

test("failed save work releases only its own reservation", async () => {
  const directory = await createTestClaimDirectory();
  await expect(
    withDocumentSaveClaim(
      identity,
      async () => {
        throw new Error("write failed");
      },
      { directory },
    ),
  ).rejects.toThrow("write failed");
  expect(await readdir(directory)).toEqual([]);
  expect(await withDocumentSaveClaim(identity, async () => "retry", { directory })).toBe("retry");
});

test("definitely dead process reservations are removed without touching a replacement generation", async () => {
  const directory = await createTestClaimDirectory();
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  let stale = "";
  await withDocumentSaveClaim(
    identity,
    async () => {
      const name = (await readdir(directory))[0]!;
      stale = name.replace(`-${process.pid}-`, `-${child.pid}-`);
      await writeFile(join(directory, stale), "", { flag: "wx", mode: 0o600 });
    },
    { directory },
  );
  expect(await readdir(directory)).toEqual([stale]);
  await withDocumentSaveClaim(
    identity,
    async () => {
      expect(await readdir(directory)).toHaveLength(1);
    },
    { directory },
  );
  expect(await readdir(directory)).toEqual([]);
});

test("separate processes cannot enter the same inode's critical section", async () => {
  const directory = await createTestClaimDirectory();
  const started = createTestDeferred<void>();
  const release = createTestDeferred<void>();
  const first = withDocumentSaveClaim(
    identity,
    async () => {
      started.resolve();
      await release.promise;
    },
    { directory },
  );
  const module = new URL("./documentSaveClaim.ts", import.meta.url).href;
  const output = join(directory, "child-result.txt");

  try {
    await started.promise;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { withDocumentSaveClaim } from ${JSON.stringify(module)};
      import { writeFile } from "node:fs/promises";
      try { await withDocumentSaveClaim(${JSON.stringify(identity)}, async () => "unexpected", { directory: ${JSON.stringify(directory)} }); process.exit(2); }
      catch(error) { await writeFile(${JSON.stringify(output)}, error.message); }`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    expect(await readFile(output, "utf8")).toContain("Another Hunk session is saving");
  } finally {
    release.resolve();
    await first;
  }
});

test("default reservations remain shared across session home and temporary-directory overrides", async () => {
  const fixture = await createTestClaimDirectory();
  const file = join(fixture, "original.txt");
  await writeFile(file, "original");
  const info = await lstat(file);
  const identity = { dev: info.dev, ino: info.ino };
  const started = createTestDeferred<void>();
  const release = createTestDeferred<void>();
  const first = withDocumentSaveClaim(identity, async () => {
    started.resolve();
    await release.promise;
  });
  const module = new URL("./documentSaveClaim.ts", import.meta.url).href;
  const output = join(fixture, "result.txt");

  try {
    await started.promise;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { withDocumentSaveClaim } from ${JSON.stringify(module)};
      import { writeFile } from "node:fs/promises";
      try { await withDocumentSaveClaim(${JSON.stringify(identity)}, async () => "unexpected"); process.exit(2); }
      catch(error) { await writeFile(${JSON.stringify(output)}, error.message); }`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: fixture,
          USERPROFILE: fixture,
          USER: "hunk-save-test",
          TMPDIR: fixture,
          TMP: fixture,
          TEMP: fixture,
          XDG_RUNTIME_DIR: fixture,
        },
      },
    );
    expect(await child.exited).toBe(0);
    expect(await readFile(output, "utf8")).toContain("Another Hunk session is saving");
  } finally {
    release.resolve();
    await first;
  }
});

test.skipIf(process.platform === "win32")(
  "coordination refuses a publicly accessible namespace",
  async () => {
    const directory = await createTestClaimDirectory();
    await chmod(directory, 0o755);
    await expect(withDocumentSaveClaim(identity, async () => null, { directory })).rejects.toThrow(
      "account-private",
    );
  },
);
