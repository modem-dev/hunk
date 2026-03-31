import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

const { loadAppBootstrap } = await import("../src/core/loaders");
const { AppHost } = await import("../src/ui/AppHost");

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Settle renders long enough for the async syntax-highlight cache to populate.
 *  Without this, the plain-text fallback path masks the stale-cache bug. */
async function settleHighlights(setup: Awaited<ReturnType<typeof testRender>>) {
  for (let i = 0; i < 15; i++) {
    await flush(setup);
    await Bun.sleep(50);
  }
}

describe("reload stale highlight cache", () => {
  test("r key picks up new file content for file-pair diffs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-reload-file-"));
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");

    writeFileSync(left, "export const answer = 41;\n");
    writeFileSync(right, "export const answer = 42;\nexport const first = true;\n");

    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: { mode: "stack" },
    });

    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 220,
      height: 20,
    });

    try {
      await settleHighlights(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("first");

      // Modify the right file while hunk is open
      writeFileSync(right, "export const answer = 42;\nexport const second = true;\n");

      await act(async () => {
        await setup.mockInput.typeText("r");
      });

      let refreshed = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("second") && !frame.includes("first")) {
          refreshed = true;
          break;
        }
        await Bun.sleep(50);
      }

      expect(refreshed).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("r key picks up new file content for git working tree diffs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-reload-git-"));
    const file = join(dir, "test.txt");

    execSync("git init && git config user.email test@test && git config user.name test", {
      cwd: dir,
      stdio: "ignore",
    });
    writeFileSync(file, "original line\n");
    execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });

    writeFileSync(file, "original line\nfirst change\n");

    const bootstrap = await loadAppBootstrap(
      { kind: "git", staged: false, options: { mode: "stack", excludeUntracked: true } },
      { cwd: dir },
    );

    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 120,
      height: 20,
    });

    try {
      await settleHighlights(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("first change");

      writeFileSync(file, "original line\nsecond change\n");

      await act(async () => {
        await setup.mockInput.typeText("r");
      });

      let refreshed = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("second change") && !frame.includes("first change")) {
          refreshed = true;
          break;
        }
        await Bun.sleep(50);
      }

      expect(refreshed).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
