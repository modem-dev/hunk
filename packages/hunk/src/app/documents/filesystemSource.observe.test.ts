import { expect, test } from "bun:test";
import { watch } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemSource } from "./filesystemSource";

/** Perform a mutation and wait for native delivery, still inside the source's 100ms debounce. */
async function receiveTestChange(directory: string, mutate: () => Promise<void>) {
  let received = false;
  const watcher = watch(directory, () => {
    received = true;
  });

  try {
    await mutate();
    const deadline = Date.now() + 3000;
    while (!received && Date.now() < deadline) await Bun.sleep(5);
    expect(received).toBe(true);
    // Let sibling native callbacks run before handing over demand.
    await Bun.sleep(20);
  } finally {
    watcher.close();
  }
}

/** Wait for one debounced native notification without manually requesting refresh. */
async function waitForTestChange(changes: () => number, before: number) {
  const deadline = Date.now() + 3000;
  while (changes() === before && Date.now() < deadline) await Bun.sleep(20);
  expect(changes()).toBeGreaterThan(before);
  // Let any additional native event settle before checking a subsequent mutation.
  await Bun.sleep(150);
}

/** Run an observation assertion inside a canonicalized, isolated collection. */
async function withTestCollection(run: (root: string) => Promise<void>) {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "hunk-observe-")));
  const root = join(fixture, "collection");

  try {
    // Parent anchors must stay isolated from other tests creating siblings in the system temp dir.
    await mkdir(root);
    await run(root);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

test("a pending event transfers to new demand without calling the revoked subscriber", async () => {
  await withTestCollection(async (root) => {
    const source = await createFilesystemSource(root);
    const file = join(root, "selected.txt");
    let revokedChanges = 0;
    let changes = 0;
    let stop = source.observe!([root], () => revokedChanges++);

    try {
      await receiveTestChange(root, () => writeFile(file, "new"));
      stop();
      stop = source.observe!([root, file], () => changes++);
      await Bun.sleep(300);
      expect(revokedChanges).toBe(0);
      expect(changes).toBe(1);
    } finally {
      stop();
    }
  });
});

test("final cleanup cancels a pending event and does not replay it to a later observer", async () => {
  await withTestCollection(async (root) => {
    const source = await createFilesystemSource(root);
    let changes = 0;
    let stop = source.observe!([root], () => changes++);

    try {
      await receiveTestChange(root, () => writeFile(join(root, "new.txt"), "new"));
      stop();
      await Bun.sleep(200);
      expect(changes).toBe(0);
      stop = source.observe!([root], () => changes++);
      await Bun.sleep(200);
      expect(changes).toBe(0);
    } finally {
      stop();
    }
  });
});

test("repeated demand handovers replay one actual event and never create phantom refreshes", async () => {
  await withTestCollection(async (root) => {
    const folder = join(root, "folder");
    await mkdir(folder);
    const source = await createFilesystemSource(root);
    let changes = 0;
    let stop = source.observe!([root], () => changes++);
    const handover = () => {
      for (let index = 0; index < 8; index++) {
        stop();
        stop = source.observe!(index % 2 ? [root] : [root, folder], () => changes++);
      }
    };

    try {
      handover();
      await Bun.sleep(200);
      expect(changes).toBe(0);
      await receiveTestChange(root, () => writeFile(join(root, "new.txt"), "new"));
      handover();
      await Bun.sleep(300);
      expect(changes).toBe(1);
      handover();
      await Bun.sleep(300);
      expect(changes).toBe(1);
    } finally {
      stop();
    }
  });
});

test("same-path directory replacements keep observing edits, children and atomic saves", async () => {
  await withTestCollection(async (root) => {
    const folder = join(root, "folder");
    const file = join(folder, "selected.txt");
    await mkdir(folder);
    await writeFile(file, "initial");
    const source = await createFilesystemSource(root);
    let changes = 0;
    const count = () => changes;
    const stop = source.observe!([folder, file], () => changes++);

    try {
      for (let index = 0; index < 3; index++) {
        const replacement = join(root, `replacement-${index}`);
        const retired = join(root, `retired-${index}`);
        await mkdir(replacement);
        await writeFile(join(replacement, "selected.txt"), "replacement");
        let before = changes;
        await rename(folder, retired);
        await rename(replacement, folder);
        await waitForTestChange(count, before);

        before = changes;
        await writeFile(file, "later edit");
        await waitForTestChange(count, before);
        before = changes;
        await writeFile(join(folder, "new-child.txt"), "new child");
        await waitForTestChange(count, before);
        before = changes;
        const atomic = join(folder, "atomic.txt");
        await writeFile(atomic, "atomic save");
        await rename(atomic, file);
        await waitForTestChange(count, before);

        // Old-inode activity must not revive a retired callback after rebind.
        before = changes;
        await writeFile(join(retired, "selected.txt"), "retired edit");
        await Bun.sleep(250);
        expect(changes).toBe(before);
      }

      const before = changes;
      await receiveTestChange(folder, () => writeFile(file, "pending at shutdown"));
      stop();
      await writeFile(join(folder, "post-close.txt"), "closed");
      await Bun.sleep(250);
      expect(changes).toBe(before);
    } finally {
      stop();
    }
  });
}, 15_000);

test("parent anchors restore a deleted demanded directory without replacing observation", async () => {
  await withTestCollection(async (root) => {
    const folder = join(root, "folder");
    await mkdir(folder);
    const source = await createFilesystemSource(root);
    let changes = 0;
    const count = () => changes;
    const stop = source.observe!([folder], () => changes++);

    try {
      await rm(folder, { recursive: true });
      await waitForTestChange(count, 0);
      let before = changes;
      await mkdir(folder);
      await waitForTestChange(count, before);
      before = changes;
      await writeFile(join(folder, "restored.txt"), "restored");
      await waitForTestChange(count, before);
    } finally {
      stop();
    }
  });
});

test("rebind preserves pending notifications and does not create a refresh loop", async () => {
  await withTestCollection(async (root) => {
    const folder = join(root, "folder");
    await mkdir(folder);
    const source = await createFilesystemSource(root);
    let changes = 0;
    const stop = source.observe!([folder], () => changes++);

    try {
      await receiveTestChange(folder, () => writeFile(join(folder, "pending.txt"), "pending"));
      await rename(folder, join(root, "retired"));
      await mkdir(folder);
      await writeFile(join(folder, "fresh.txt"), "fresh");
      await Bun.sleep(350);
      expect(changes).toBe(1);
      await Bun.sleep(300);
      expect(changes).toBe(1);
    } finally {
      stop();
    }
  });
});

test.skipIf(process.platform === "win32")(
  "recreating a target never follows a final directory symlink",
  async () => {
    await withTestCollection(async (root) => {
      const folder = join(root, "folder");
      const outside = join(root, "outside");
      await mkdir(folder);
      await mkdir(outside);
      const source = await createFilesystemSource(root);
      let changes = 0;
      const stop = source.observe!([folder], () => changes++);

      try {
        await rm(folder, { recursive: true });
        await symlink(outside, folder, "dir");
        await waitForTestChange(() => changes, 0);
        const before = changes;
        await writeFile(join(outside, "secret.txt"), "outside");
        await Bun.sleep(300);
        expect(changes).toBe(before);
        await rm(folder);
        await mkdir(folder);
        await waitForTestChange(() => changes, before);
        const restored = changes;
        await writeFile(join(folder, "inside.txt"), "inside");
        await waitForTestChange(() => changes, restored);
      } finally {
        stop();
      }
    });
  },
);
