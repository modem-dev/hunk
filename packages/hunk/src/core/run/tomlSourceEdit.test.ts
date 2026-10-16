import { describe, expect, test } from "bun:test";
import { scanTomlSource, tomlTableDefinesKey, upsertTomlValue } from "./tomlSourceEdit";

const lines = (...text: string[]) => `${text.join("\n")}\n`;

/** Parse a source and assert it round-trips through Bun's TOML parser. */
function parsed(source: string | null) {
  expect(source).not.toBeNull();
  return Bun.TOML.parse(source!) as Record<string, unknown>;
}

describe("scanTomlSource", () => {
  test("reads headers by parsed path whatever quoting they use", () => {
    const scanned = scanTomlSource(
      ['["theme"]', "[ theme ]", "[diff.'theme']", "[[items]]"].join("\n"),
    );
    expect(
      scanned.map((line) => (line.kind === "header" ? [line.path, line.arrayOfTables] : line.kind)),
    ).toEqual([
      [["theme"], false],
      [["theme"], false],
      [["diff", "theme"], false],
      [["items"], true],
    ]);
  });

  test("keeps table-like text inside multiline strings out of the structure", () => {
    const scanned = scanTomlSource(
      [
        "[extension.docs]",
        'readme = """',
        "[theme]",
        'dark = "x"',
        '"""',
        "paths = [",
        '  "[theme]",',
        "]",
        "next = 'it''s' # done",
      ].join("\n"),
    );
    expect(scanned.map((line) => line.kind)).toEqual([
      "header",
      "assignment",
      "continuation",
      "continuation",
      "continuation",
      "assignment",
      "continuation",
      "continuation",
      "assignment",
    ]);
    const last = scanned.at(-1);
    expect(last?.kind === "assignment" && last.comment).toBe("# done");
  });

  test("marks lines it cannot classify instead of guessing", () => {
    expect(scanTomlSource("[theme\n= 3").map((line) => line.kind)).toEqual(["unknown", "unknown"]);
  });
});

describe("upsertTomlValue", () => {
  test('rewrites a quoted ["theme"] header\'s keys in place', () => {
    const source = lines('mode = "split"', "", '["theme"]', 'dark = "a"', 'light = "b"');
    const next = upsertTomlValue(source, [], "theme", { dark: "c", light: "d", fallback: "e" });
    expect(next).toBe(
      lines('mode = "split"', "", '["theme"]', 'dark = "c"', 'light = "d"', 'fallback = "e"'),
    );
    expect(parsed(next)).toEqual({
      mode: "split",
      theme: { dark: "c", light: "d", fallback: "e" },
    });
  });

  test("collapses a quoted header to a root key instead of adding a second definition", () => {
    const source = lines('["theme"]', 'dark = "a"', 'light = "b"');
    const next = upsertTomlValue(source, [], "theme", "solo");
    expect(next).toBe(lines('theme = "solo"'));
  });

  test("leaves a [theme] example inside a multiline string alone", () => {
    const source = lines(
      "[extension.docs]",
      'readme = """',
      "[theme]",
      'dark = "x"',
      '"""',
      "",
      "[theme]",
      'dark = "a"',
      'light = "b"',
    );
    const next = upsertTomlValue(source, [], "theme", "solo");
    expect(next).toBe(
      lines(
        'theme = "solo"',
        "",
        "[extension.docs]",
        'readme = """',
        "[theme]",
        'dark = "x"',
        '"""',
      ),
    );
    const document = parsed(next);
    expect(document).toMatchObject({ theme: "solo" });
    expect(document).toHaveProperty(
      ["extension", "docs", "readme"],
      expect.stringContaining("[theme]"),
    );
  });

  test("moves every comment of a collapsed table onto the key", () => {
    const source = lines(
      'mode = "split"',
      "",
      "# picked per background",
      "[theme] # both sides",
      "# the night side",
      'dark = "a" # dim',
      'light = "b"',
      "",
      "# colours",
      "[custom_theme]",
      'label = "keep"',
    );
    const next = upsertTomlValue(source, [], "theme", "solo");
    expect(next).toBe(
      lines(
        'mode = "split"',
        "",
        "# picked per background",
        "# the night side",
        "# dim",
        'theme = "solo" # both sides',
        "",
        "# colours",
        "[custom_theme]",
        'label = "keep"',
      ),
    );
  });

  test("writes into a command table and collapses its [diff.theme] sub-table there", () => {
    const source = lines(
      'theme = "root"',
      "",
      "[diff]",
      'mode = "stack"',
      "",
      "[diff.theme]",
      'dark = "a"',
      'light = "b"',
    );
    expect(tomlTableDefinesKey(source, ["diff"], "theme")).toBe(true);
    expect(tomlTableDefinesKey(source, ["diff"], "line_numbers")).toBe(false);
    const next = upsertTomlValue(source, ["diff"], "theme", "solo");
    expect(next).toBe(lines('theme = "root"', "", "[diff]", 'mode = "stack"', 'theme = "solo"'));
    expect(parsed(next)).toEqual({ theme: "root", diff: { mode: "stack", theme: "solo" } });
  });

  test("rewrites a scoped assignment in place, keeping its comment", () => {
    const source = lines("[pager]", 'theme = "a" # for less', 'mode = "stack"');
    const next = upsertTomlValue(source, ["pager"], "theme", { dark: "c", light: "d" });
    expect(next).toBe(
      lines("[pager]", 'theme = { dark = "c", light = "d" } # for less', 'mode = "stack"'),
    );
  });

  test("folds dotted and duplicate definitions into the first one", () => {
    const source = lines('theme.dark = "a" # night', "wrap_lines = true", 'theme.light = "b"');
    const next = upsertTomlValue(source, [], "theme", "solo");
    expect(next).toBe(lines('theme = "solo" # night', "wrap_lines = true"));
  });

  test("adds a root key above the first header and keeps that header's comment attached", () => {
    const source = lines("# personal", "", "# my colours", "[custom_theme]", 'label = "keep"');
    const next = upsertTomlValue(source, [], "mode", "split");
    expect(next).toBe(
      lines("# personal", 'mode = "split"', "", "# my colours", "[custom_theme]", 'label = "keep"'),
    );
  });

  test("starts an empty file with the key alone", () => {
    expect(upsertTomlValue("", [], "mode", "split")).toBe(lines('mode = "split"'));
  });

  test("refuses scopes that do not exist and keys held in arrays of tables", () => {
    expect(upsertTomlValue(lines('mode = "split"'), ["diff"], "theme", "solo")).toBeNull();
    expect(upsertTomlValue(lines("[[theme]]", 'dark = "a"'), [], "theme", "solo")).toBeNull();
  });
});
