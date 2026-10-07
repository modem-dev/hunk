import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemSource } from "../../app/documents/filesystemSource";
import { DocumentBrowserController } from "./controller";

/** Wait for real filesystem debounce and Git metadata work without requesting another refresh. */
async function waitForTestEntry(browser: DocumentBrowserController, name: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (browser.getSnapshot().rows.some((row) => row.entry.name === name)) return;
    await Bun.sleep(20);
  }

  expect(browser.getSnapshot().rows.map((row) => row.entry.name)).toContain(name);
}

test("selecting a file during watch debounce preserves the pending tree change", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "hunk-document-selection-")));
  const root = join(fixture, "collection");
  let browser: DocumentBrowserController | undefined;

  try {
    await mkdir(root);
    const file = join(root, "selected.txt");
    await writeFile(file, "selected");
    const source = await createFilesystemSource(root);
    const observe = source.observe!;
    let changes = 0;
    source.observe = (keys, onChange) =>
      observe(keys, () => {
        changes++;
        onChange();
      });
    browser = new DocumentBrowserController(source);
    await browser.initialize();
    await writeFile(join(root, "new.txt"), "new");
    await Bun.sleep(30);
    await browser.select(file);
    await waitForTestEntry(browser, "new.txt");
    expect(browser.getSnapshot().document).toMatchObject({ kind: "text", text: "selected" });
    expect(browser.getSnapshot().selectedKey).toBe(file);
    expect(changes).toBe(1);
    await Bun.sleep(300);
    expect(changes).toBe(1);
  } finally {
    await browser?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

/** Wait for watched document content without requesting a manual refresh. */
async function waitForTestDocument(browser: DocumentBrowserController, text: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const document = browser.getSnapshot().document;
    if (document?.kind === "text" && document.text === text) return;
    await Bun.sleep(20);
  }

  expect(browser.getSnapshot().document).toMatchObject({ kind: "text", text });
}

test("same-path folder replacement refreshes unchanged controller demand and subsequent saves", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "hunk-document-rebind-")));
  const root = join(fixture, "collection");
  const folder = join(root, "folder");
  const file = join(folder, "selected.txt");
  let browser: DocumentBrowserController | undefined;

  try {
    await mkdir(folder, { recursive: true });
    await writeFile(file, "initial");
    const source = await createFilesystemSource(root);
    const observe = source.observe!;
    let subscriptions = 0;
    let changes = 0;
    source.observe = (keys, onChange) => {
      subscriptions++;
      return observe(keys, () => {
        changes++;
        onChange();
      });
    };
    browser = new DocumentBrowserController(source);
    await browser.initialize();
    await browser.activate(folder);
    await browser.select(file);
    const initialSubscriptions = subscriptions;

    for (let index = 0; index < 2; index++) {
      const replacement = join(fixture, `replacement-${index}`);
      await mkdir(replacement);
      await writeFile(join(replacement, "selected.txt"), `replacement ${index}`);
      await rename(folder, join(fixture, `retired-${index}`));
      await rename(replacement, folder);
      await waitForTestDocument(browser, `replacement ${index}`);
      await writeFile(file, `later edit ${index}`);
      await waitForTestDocument(browser, `later edit ${index}`);
      await writeFile(join(folder, `child-${index}.txt`), "child");
      await waitForTestEntry(browser, `child-${index}.txt`);
      const atomic = join(folder, "atomic.txt");
      await writeFile(atomic, `atomic save ${index}`);
      await rename(atomic, file);
      await waitForTestDocument(browser, `atomic save ${index}`);
      expect(subscriptions).toBe(initialSubscriptions);
      expect(browser.getSnapshot().selectedKey).toBe(file);
      expect(browser.getSnapshot().expanded.has(folder)).toBe(true);
    }

    await rm(folder, { recursive: true });
    const deadline = Date.now() + 3000;
    while (browser.getSnapshot().document?.kind !== "unavailable" && Date.now() < deadline)
      await Bun.sleep(20);
    expect(browser.getSnapshot().document).toMatchObject({
      kind: "unavailable",
      reason: "missing",
    });
    await mkdir(folder);
    await writeFile(file, "recreated");
    await waitForTestDocument(browser, "recreated");
    await waitForTestEntry(browser, "folder");
    await browser.activate(folder);
    await writeFile(join(folder, "after-recreation.txt"), "new");
    await waitForTestEntry(browser, "after-recreation.txt");
    await writeFile(file, "after recreation");
    await waitForTestDocument(browser, "after recreation");
    expect(browser.getSnapshot().notice).toBeNull();

    await browser.close();
    const finalChanges = changes;
    const finalSnapshot = browser.getSnapshot();
    await writeFile(file, "closed");
    await Bun.sleep(250);
    expect(changes).toBe(finalChanges);
    expect(browser.getSnapshot()).toBe(finalSnapshot);
  } finally {
    await browser?.close();
    await rm(fixture, { recursive: true, force: true });
  }
}, 15_000);

for (const trigger of ["initial expansion", "manual refresh"] as const) {
  test(`a file created during ${trigger} metadata queries survives watch debounce`, async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), "hunk-document-watch-")));
    const root = join(fixture, "collection");
    let browser: DocumentBrowserController | undefined;

    try {
      await mkdir(root);
      await writeFile(join(root, "old.txt"), "old");
      expect(Bun.spawnSync(["git", "init", "--quiet"], { cwd: root }).exitCode).toBe(0);
      let inject = trigger === "initial expansion";
      let injections = 0;
      const source = await createFilesystemSource(root, {
        spawn: ((...args: Parameters<typeof Bun.spawn>) => {
          const [command, options] = args;
          if (inject && Array.isArray(command) && command.includes("check-ignore")) {
            inject = false;
            injections++;
            // Enumeration has finished, but the successful Git query has not. The real watch
            // notification starts a 100ms debounce that must outlive this listing's completion.
            writeFileSync(join(root, "new.txt"), "new");
            return Bun.spawn(
              [
                process.execPath,
                "-e",
                `await Bun.sleep(25);
                 const child = Bun.spawn(${JSON.stringify(command)}, {
                   stdin: "inherit", stdout: "inherit", stderr: "inherit"
                 });
                 process.exit(await child.exited);`,
              ],
              options,
            );
          }
          return Bun.spawn(...args);
        }) as typeof Bun.spawn,
      });
      const observe = source.observe!;
      let subscriptions = 0;
      source.observe = (keys, onChange) => {
        subscriptions++;
        return observe(keys, onChange);
      };
      browser = new DocumentBrowserController(source);
      await browser.initialize();
      if (trigger === "manual refresh") {
        inject = true;
        await browser.refresh();
      }

      expect(injections).toBe(1);
      await waitForTestEntry(browser, "new.txt");
      expect(browser.getSnapshot().notice).toBeNull();
      expect(browser.getSnapshot().rows.some((row) => row.entry.name === "old.txt")).toBe(true);
      expect(subscriptions).toBe(1);
    } finally {
      await browser?.close();
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
