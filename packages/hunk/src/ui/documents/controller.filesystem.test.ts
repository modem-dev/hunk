import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
