import { describe, expect, test } from "bun:test";
import { renderColorOnlyDiff } from "./colorOnlyFilter";

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

const PATCH = [
  "diff --git a/example.ts b/example.ts",
  "index 1234567..89abcde 100644",
  "--- a/example.ts",
  "+++ b/example.ts",
  "@@ -1,3 +1,3 @@",
  " const keep = 1;",
  '-const old = "gone";',
  '+const fresh = "new";',
  "\\ No newline at end of file",
].join("\n");

describe("color-only filter", () => {
  test("colors diff lines while preserving the exact input structure", async () => {
    const output = await renderColorOnlyDiff(`${PATCH}\n`);

    // A diffFilter consumer re-parses stdout after stripping ANSI, so structure is sacred.
    expect(stripAnsi(output)).toBe(`${PATCH}\n`);
    expect(output).toContain("\x1b[38;2;"); // header / syntax foreground colors
    expect(output).toContain("\x1b[48;2;"); // added / removed backgrounds
    expect(output).not.toContain("\x1b[?1049h"); // never enters the alternate screen
  });

  test("applies syntax highlighting to changed lines", async () => {
    const output = await renderColorOnlyDiff(`${PATCH}\n`);
    const addedLine = output
      .split("\n")
      .find((line) => stripAnsi(line) === '+const fresh = "new";');

    expect(addedLine).toBeDefined();
    // The sign color plus at least keyword/identifier/string spans all carry their own SGR run.
    expect(addedLine!.match(/\x1b\[/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  test("passes non-diff input through byte-identical", async () => {
    const text = "just some output\nthat is not a diff\n";

    expect(await renderColorOnlyDiff(text)).toBe(text);
    expect(await renderColorOnlyDiff("")).toBe("");
  });

  test("recolors ANSI-colored diff input", async () => {
    const colored = PATCH.replace(/\+const fresh/g, "\x1b[32m+const fresh\x1b[0m");

    const output = await renderColorOnlyDiff(`${colored}\n`);

    expect(stripAnsi(output)).toBe(`${PATCH}\n`);
    expect(output).not.toContain("\x1b[32m");
  });

  test("keeps tab-indented content bytes intact", async () => {
    const tabbedPatch = [
      "diff --git a/makefile b/makefile",
      "--- a/makefile",
      "+++ b/makefile",
      "@@ -1 +1 @@",
      "-\tall:",
      "+\tall: build",
    ].join("\n");

    const output = await renderColorOnlyDiff(`${tabbedPatch}\n`);

    // Highlight spans expand tabs, so those lines fall back to whole-line color — never rewrite.
    expect(stripAnsi(output)).toBe(`${tabbedPatch}\n`);
    expect(output).toContain("\tall: build");
  });

  test("treats +++ and --- prefixed content inside hunks as content lines", async () => {
    const tricky = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,2 +1,2 @@",
      "--- old heading",
      "+-+ new heading",
      " +++ nested",
    ].join("\n");

    const output = await renderColorOnlyDiff(`${tricky}\n`);

    expect(stripAnsi(output)).toBe(`${tricky}\n`);
    expect(output).toContain("\x1b[48;2;"); // the tricky lines still count as added/removed rows
  });

  test("colors a headerless patch that starts directly at a hunk header", async () => {
    const headerless = ["@@ -1 +1 @@", "-old line", "+new line"].join("\n");

    const output = await renderColorOnlyDiff(`${headerless}\n`);

    expect(stripAnsi(output)).toBe(`${headerless}\n`);
    expect(output).toContain("\x1b[48;2;23;51;34m"); // added background band present
  });

  test("colors every file of a multi-file diff", async () => {
    const multi = [
      "diff --git a/one.ts b/one.ts",
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1 +1 @@",
      "-const one = 1;",
      "+const one = 11;",
      "diff --git a/two.ts b/two.ts",
      "--- a/two.ts",
      "+++ b/two.ts",
      "@@ -1 +1 @@",
      "-const two = 2;",
      "+const two = 22;",
    ].join("\n");

    const output = await renderColorOnlyDiff(`${multi}\n`);

    expect(stripAnsi(output)).toBe(`${multi}\n`);
    const changed = output.split("\n").filter((line) => line.includes("\x1b[48;2;"));
    expect(changed.length).toBeGreaterThanOrEqual(4);
  });

  test("falls back to whole-line colors when the diff model fails to load", async () => {
    const warnings: string[] = [];
    const output = await renderColorOnlyDiff(
      `${PATCH}\n`,
      {},
      {
        stderr: { write: (text: string) => (warnings.push(text), true) },
        loadAppBootstrapImpl: async () => {
          throw new Error("boom");
        },
      },
    );

    expect(stripAnsi(output)).toBe(`${PATCH}\n`);
    expect(output).toContain("\x1b[48;2;"); // added / removed backgrounds survive the fallback
    expect(warnings.join("\n")).toContain("falling back");
  });

  test("keeps a trailing carriage return on CRLF input", async () => {
    const crlfPatch = PATCH.replace(/\n/g, "\r\n");

    const output = await renderColorOnlyDiff(crlfPatch);

    expect(stripAnsi(output)).toBe(crlfPatch);
  });
});
