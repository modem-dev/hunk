import { expect, test } from "bun:test";
import { watch } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
