import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

setDefaultTimeout(30_000);

test.skipIf(process.platform === "win32")(
  "open keeps watching an expanded folder after same-path replacement",
  async () => {
    const harness = createPtyHarness();
    const fixture = await realpath(await mkdtemp(join(tmpdir(), "hunk-open-watch-pty-")));
    const root = join(fixture, "collection");
    const folder = join(root, "nested");
    const file = join(folder, "selected.txt");

    try {
      await mkdir(folder, { recursive: true });
      await writeFile(file, "INITIAL_WATCHED_DOCUMENT\n");
      const session = await harness.launchHunk({ args: ["open", root], cols: 120, rows: 24 });

      try {
        await session.waitForText("nested");
        await harness.ensureKeyboardIsLive(session);
        await session.press("down");
        await session.press("right");
        await session.waitForText("selected.txt");
        await session.press("down");
        await session.waitForText("INITIAL_WATCHED_DOCUMENT");

        for (let index = 0; index < 2; index++) {
          const replacement = join(fixture, `replacement-${index}`);
          await mkdir(replacement);
          await writeFile(join(replacement, "selected.txt"), `REPLACED_DOCUMENT_${index}\n`);
          await rename(folder, join(fixture, `retired-${index}`));
          await rename(replacement, folder);
          await session.waitForText(`REPLACED_DOCUMENT_${index}`);
          await writeFile(file, `LATER_EDIT_${index}\n`);
          await session.waitForText(`LATER_EDIT_${index}`);
          await writeFile(join(folder, `new-child-${index}.txt`), "new child\n");
          await session.waitForText(`new-child-${index}.txt`);
          const atomic = join(folder, "atomic.txt");
          await writeFile(atomic, `ATOMIC_SAVE_${index}\n`);
          await rename(atomic, file);
          const frame = await session.waitForText(`ATOMIC_SAVE_${index}`);
          expect(frame).not.toContain(`LATER_EDIT_${index}`);
        }

        await rm(folder, { recursive: true });
        await session.waitForText("File no longer exists");
        await mkdir(folder);
        await writeFile(file, "RECREATED_DOCUMENT\n");
        await session.waitForText("RECREATED_DOCUMENT");
        await writeFile(file, "EDIT_AFTER_RECREATION\n");
        await session.waitForText("EDIT_AFTER_RECREATION");
        await session.press("q");
      } finally {
        session.close();
      }
    } finally {
      harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
