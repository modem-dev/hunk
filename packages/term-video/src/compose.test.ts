import { describe, expect, test } from "bun:test";
import { buildConcatManifest } from "./compose.mjs";

describe("buildConcatManifest", () => {
  test("sets the source framerate for every entry and the repeated final frame", () => {
    expect(
      buildConcatManifest(
        [
          { file: "out/f0000.png", duration: 1 / 30 },
          { file: "out/f0001.png", duration: 0.4 },
        ],
        30,
      ),
    ).toBe(
      [
        "ffconcat version 1.0",
        "file 'out/f0000.png'",
        "option framerate 30",
        "duration 0.03333",
        "file 'out/f0001.png'",
        "option framerate 30",
        "duration 0.40000",
        "file 'out/f0001.png'",
        "option framerate 30",
        "",
      ].join("\n"),
    );
  });
});
