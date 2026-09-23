import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { removeTestDirectory } from "../../../../test/helpers/filesystem";
import { TestAppHost as AppHost } from "../../../../test/helpers/app-host";
import { capturedTestColorToHex } from "../../../../test/helpers/test-color-helpers";
import type { AppBootstrap } from "../app/types";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import { loadAppBootstrap as loadCoreAppBootstrap } from "../core/changeset/loaders";
import { loadStartupExtensions } from "../extensions/startup";
import { resolveTheme } from "./themes";

/**
 * The bundled content search, driven through the real app with user extensions
 * disabled: `/` opens the status-line prompt, Enter lands on the matching line,
 * `n` / `N` step and wrap, the status row reports each landing, and the diff
 * carries the current-match mark. Search semantics are unit-tested beside
 * `extensions/default/ui/search/`; this file covers the host wiring.
 */

const tempDirs: string[] = [];
const originalConfigHome = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = createTempDir("hunk-search-xdg-");
});

afterEach(async () => {
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  for (const dir of tempDirs.splice(0)) {
    await removeTestDirectory(dir);
  }
});

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Sixty context lines between the two hunks, so the second sits well below the first fold. */
const FILLER = Array.from({ length: 60 }, (_, index) => `const filler${index} = ${index};`).join(
  "\n",
);

/**
 * Two changed files: alpha has `readConfig` in two separate hunks, beta has one.
 * Every match is a unique-looking line so frame assertions can name the row.
 */
function createTestRepo(prefix: string) {
  const repo = createTempDir(prefix);
  execSync("git init && git config user.email test@test && git config user.name test", {
    cwd: repo,
    stdio: "ignore",
  });
  writeFileSync(join(repo, "alpha.ts"), `const top = 1;\n${FILLER}\nconst bottom = 2;\n`);
  writeFileSync(join(repo, "beta.ts"), "const other = 1;\n");
  execSync("git add . && git commit -m init", { cwd: repo, stdio: "ignore" });
  writeFileSync(
    join(repo, "alpha.ts"),
    `const top = readConfig("first");\n${FILLER}\nconst bottom = readConfig("second");\n`,
  );
  writeFileSync(join(repo, "beta.ts"), 'const other = readConfig("third");\n');
  return repo;
}

/** Launch a review with user extensions disabled, as `--no-extensions` does. */
async function launchWithoutExtensions(repo: string): Promise<AppBootstrap> {
  const bootstrap = (await loadCoreAppBootstrap(
    { kind: "vcs", staged: false, options: { mode: "unified" } },
    { cwd: repo, vcsCatalog: getBundledVcsCatalog() },
  )) as AppBootstrap;
  bootstrap.extensions = await loadStartupExtensions({
    extensions: { enabled: false, paths: [], repoPaths: [], extensionConfigs: {} },
    cwd: repo,
  });
  expect(bootstrap.extensions.registry.commands).toEqual([]);
  return bootstrap;
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Render frames until a condition holds, and fail loudly when it never does. */
async function flushUntil(
  setup: Awaited<ReturnType<typeof testRender>>,
  predicate: () => boolean,
  description: string,
  timeoutMs = 4_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${description}.\n${setup.captureCharFrame()}`,
      );
    }
    await flush(setup);
    await act(async () => {
      await Bun.sleep(20);
    });
  }
}

async function withAppHost(
  bootstrap: AppBootstrap,
  body: (setup: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
) {
  // Short enough that alpha's second hunk starts below the fold, so a landing there must scroll.
  const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 120, height: 14 });
  try {
    await flush(setup);
    await flushUntil(
      setup,
      () => setup.captureCharFrame().includes("alpha.ts"),
      "the review to render",
    );
    await body(setup);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

/** Read the status row: the last non-empty line of the frame. */
function statusRow(setup: Awaited<ReturnType<typeof testRender>>) {
  return setup.captureCharFrame().trimEnd().split("\n").at(-1) ?? "";
}

/** The frame's rows, for locating where a landing put the matched line. */
function rowIndexOf(setup: Awaited<ReturnType<typeof testRender>>, needle: string) {
  return setup
    .captureCharFrame()
    .split("\n")
    .findIndex((line) => line.includes(needle));
}

/** Whether the frame paints `needle` with the inverted "current" mark background. */
function hasCurrentMarkOn(setup: Awaited<ReturnType<typeof testRender>>, needle: string) {
  const text = resolveTheme("github-dark-default", null).text.toLowerCase();
  return setup
    .captureSpans()
    .lines.some((line) =>
      line.spans.some(
        (span) =>
          span.text.includes(needle) && capturedTestColorToHex(span.bg)?.toLowerCase() === text,
      ),
    );
}

async function type(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  await act(async () => {
    await setup.mockInput.typeText(text);
  });
}

/** Whether the search prompt is open with an empty buffer, showing its placeholder. */
function promptIsEmpty(setup: Awaited<ReturnType<typeof testRender>>) {
  return statusRow(setup).trimStart().startsWith("/ search diff");
}

async function openPrompt(setup: Awaited<ReturnType<typeof testRender>>) {
  await type(setup, "/");
  await flushUntil(
    setup,
    () => statusRow(setup).trimStart().startsWith("/"),
    "the search prompt to open",
  );
}

async function pressEscape(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.mockInput.pressEscape();
  });
}

async function submit(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.mockInput.pressEnter();
  });
}

/**
 * Open the prompt with an empty buffer, clearing a prefilled query first.
 *
 * The bundled session lives for the process, so a previous test's query prefills the prompt.
 */
async function openEmptyPrompt(setup: Awaited<ReturnType<typeof testRender>>) {
  await openPrompt(setup);
  if (!promptIsEmpty(setup)) {
    await pressEscape(setup);
    await flushUntil(setup, () => promptIsEmpty(setup), "escape to clear the prefilled query");
  }
}

/** Forget any search a previous test left behind by submitting an emptied prompt. */
async function clearSearch(setup: Awaited<ReturnType<typeof testRender>>) {
  await openEmptyPrompt(setup);
  await submit(setup);
  await flushUntil(
    setup,
    () => !statusRow(setup).trimStart().startsWith("/"),
    "the emptied submit to close the prompt",
  );
}

describe("bundled content search", () => {
  test("/ prompts, Enter lands on the match, and n / N step through the review and wrap", async () => {
    const bootstrap = await launchWithoutExtensions(createTestRepo("hunk-search-"));
    await withAppHost(bootstrap, async (setup) => {
      // The prompt shows no `ext` attribution: bundled search is Hunk's own UI.
      await openEmptyPrompt(setup);
      expect(statusRow(setup)).not.toContain("ext");

      // Smart case: the lowercase query matches `readConfig`. The review opens
      // on alpha's first hunk, and a search steps strictly forward from the
      // current hunk, so the first landing is alpha's second hunk — below the
      // fold, revealed near the top of the viewport.
      await type(setup, "readconfig");
      await submit(setup);
      await flushUntil(
        setup,
        () => statusRow(setup).includes("[2/3] alpha.ts:62"),
        "the first landing to report on the status row",
      );
      expect(statusRow(setup)).toContain('— const bottom = readConfig("second");');
      // Rows 0–1 are the menu bar and its rule; the reveal parks the line a little below.
      const secondRow = rowIndexOf(setup, 'readConfig("second")');
      expect(secondRow).toBeGreaterThan(1);
      expect(secondRow).toBeLessThan(8);
      await flushUntil(
        setup,
        () => hasCurrentMarkOn(setup, "readConfig"),
        "the landed match to carry the current mark",
      );

      await type(setup, "n");
      await flushUntil(
        setup,
        () => statusRow(setup).includes("[3/3] beta.ts:1"),
        "n to land on beta",
      );

      await type(setup, "n");
      await flushUntil(
        setup,
        () => statusRow(setup).includes("[1/3] alpha.ts:1") && statusRow(setup).includes("wrapped"),
        "n to wrap back to the first match",
      );
      expect(statusRow(setup)).toContain('— const top = readConfig("first");');
      expect(rowIndexOf(setup, 'readConfig("first")')).toBeLessThan(8);

      await type(setup, "N");
      await flushUntil(
        setup,
        () => statusRow(setup).includes("[3/3] beta.ts:1") && statusRow(setup).includes("wrapped"),
        "N to wrap back to the last match",
      );
      await type(setup, "N");
      await flushUntil(
        setup,
        () =>
          statusRow(setup).includes("[2/3] alpha.ts:62") && !statusRow(setup).includes("wrapped"),
        "N to step back without wrapping",
      );
    });
  });

  test("a miss, a repeat before searching, and an emptied prompt each report themselves", async () => {
    const bootstrap = await launchWithoutExtensions(createTestRepo("hunk-search-miss-"));
    await withAppHost(bootstrap, async (setup) => {
      await clearSearch(setup);
      await type(setup, "n");
      await flushUntil(
        setup,
        () => statusRow(setup).includes("No search yet — press / to search"),
        "n before any search to say so",
      );

      await openEmptyPrompt(setup);
      await type(setup, "zzz");
      await submit(setup);
      await flushUntil(
        setup,
        () => statusRow(setup).includes('No match for "zzz"'),
        "the miss to report on the status row",
      );

      // Reopening shows the last query; Escape clears the buffer, and submitting
      // the emptied prompt drops the search and its status item.
      await openPrompt(setup);
      await flushUntil(
        setup,
        () => statusRow(setup).includes("/ zzz"),
        "the last query to prefill",
      );
      await pressEscape(setup);
      await flushUntil(setup, () => promptIsEmpty(setup), "escape to clear the buffer");
      await submit(setup);
      await flushUntil(
        setup,
        () => !setup.captureCharFrame().includes("No match") && !promptIsEmpty(setup),
        "the emptied submit to clear the status item",
      );

      expect(hasCurrentMarkOn(setup, "readConfig")).toBe(false);

      await type(setup, "n");
      await flushUntil(
        setup,
        () => statusRow(setup).includes("No search yet"),
        "the cleared search to report no query",
      );
    });
  });

  test("the prompt preserves trailing whitespace when searching and reopening", async () => {
    const bootstrap = await launchWithoutExtensions(createTestRepo("hunk-search-spaces-"));
    await withAppHost(bootstrap, async (setup) => {
      await openEmptyPrompt(setup);
      await type(setup, "readConfig ");
      await submit(setup);
      await flushUntil(
        setup,
        () => statusRow(setup).includes('No match for "readConfig "'),
        "the search to require the trailing space",
      );
      expect(hasCurrentMarkOn(setup, "readConfig")).toBe(false);

      // Appending after reopening proves the space survived in the prompt's buffer.
      await openPrompt(setup);
      await type(setup, "(");
      await submit(setup);
      await flushUntil(
        setup,
        () => statusRow(setup).includes('No match for "readConfig ("'),
        "the reopened query to retain its space before appended text",
      );

      await openEmptyPrompt(setup);
      await type(setup, "   ");
      await submit(setup);
      await type(setup, "n");
      await flushUntil(
        setup,
        () => statusRow(setup).includes("No search yet"),
        "a whitespace-only submit to clear the search",
      );
    });
  });

  test("escape twice leaves the search in place and a reload keeps the query", async () => {
    const bootstrap = await launchWithoutExtensions(createTestRepo("hunk-search-keep-"));
    await withAppHost(bootstrap, async (setup) => {
      await openEmptyPrompt(setup);
      await type(setup, "readConfig");
      await submit(setup);
      await flushUntil(
        setup,
        () => statusRow(setup).includes("[2/3] alpha.ts:62"),
        "the first landing to report",
      );

      await openPrompt(setup);
      expect(statusRow(setup)).toContain("/ readConfig");
      await pressEscape(setup);
      await flushUntil(setup, () => promptIsEmpty(setup), "the first escape to clear the buffer");
      await pressEscape(setup);
      await flushUntil(
        setup,
        () => !statusRow(setup).trimStart().startsWith("/") && statusRow(setup).includes("[2/3]"),
        "the cancelled prompt to leave the last landing on the status row",
      );
      await flushUntil(
        setup,
        () => hasCurrentMarkOn(setup, "readConfig"),
        "the current mark to survive the cancelled prompt",
      );

      // A content reload rebuilds the visible files; `n` re-matches the kept query
      // from the live selection, which the landing left on alpha's second hunk.
      await type(setup, "r");
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("alpha.ts"),
        "the review to reload",
      );
      await type(setup, "n");
      await flushUntil(
        setup,
        () => statusRow(setup).includes("[3/3] beta.ts:1"),
        "n after the reload to step the kept query",
      );
    });
  });

  test("a filtered-out file is never a target, and Tab still opens the filter", async () => {
    const bootstrap = await launchWithoutExtensions(createTestRepo("hunk-search-filter-"));
    await withAppHost(bootstrap, async (setup) => {
      await act(async () => {
        await setup.mockInput.pressTab();
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("filter:"),
        "tab to open the file filter",
      );
      await type(setup, "beta");
      await flushUntil(
        setup,
        () => !setup.captureCharFrame().includes("alpha.ts"),
        "the filter to hide alpha",
      );
      await act(async () => {
        await setup.mockInput.pressTab();
      });
      await flushUntil(
        setup,
        () => !setup.captureCharFrame().includes("filter:"),
        "tab to leave the filter",
      );

      await openEmptyPrompt(setup);
      await type(setup, "readConfig");
      await submit(setup);
      await flushUntil(
        setup,
        () => statusRow(setup).includes("[1/1] beta.ts:1"),
        "the search to see only the visible file",
      );
    });
  });
});
