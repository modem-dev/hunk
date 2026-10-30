import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { initialsOf, isExcluded, noreplyLogin } from "./contributors.mjs";
import { compareVersions, parseArgs, storyboardProblems, storyboardsDir } from "./storyboard.mjs";

describe("release storyboards", () => {
  for (const name of readdirSync(storyboardsDir).filter((file) => file.endsWith(".mjs"))) {
    test(`${name} is a valid storyboard`, async () => {
      const { default: storyboard } = await import(join(storyboardsDir, name));
      expect(storyboardProblems(storyboard)).toEqual([]);
    });
  }

  test("reports missing content with the chapter it belongs to", () => {
    expect(
      storyboardProblems({
        version: "0.25",
        chapters: [
          {
            label: "x",
            sub: "",
            cmd: "",
            winTitle: "",
            title: ["X"],
            frames: [],
            cameras: [],
            captions: [],
          },
        ],
      }),
    ).toEqual([
      "chapters[0] (x).frames must list captured keyframes",
      "chapters[0] (x).cameras must start with a camera at time 0",
    ]);
  });
});

describe("storyboard CLI helpers", () => {
  test("orders release storyboards numerically", () => {
    expect(["0.24.0.mjs", "0.9.0.mjs", "0.25.0.mjs"].sort(compareVersions)).toEqual([
      "0.9.0.mjs",
      "0.24.0.mjs",
      "0.25.0.mjs",
    ]);
  });

  test("splits positional arguments from --flag values", () => {
    expect(parseArgs([".video-work", "--stills", "1,2", "--to", "HEAD"])).toEqual({
      positional: [".video-work"],
      flags: { stills: "1,2", to: "HEAD" },
    });
  });
});

describe("contributor identities", () => {
  test("reads logins and ids from GitHub noreply addresses", () => {
    expect(noreplyLogin("2153+benvinegar@users.noreply.github.com")).toEqual({
      login: "benvinegar",
      id: 2153,
    });
    expect(noreplyLogin("octocat@users.noreply.github.com")).toEqual({
      login: "octocat",
      id: undefined,
    });
    expect(noreplyLogin("ben@benv.ca")).toBeUndefined();
  });

  test("excludes bots and AI co-author trailers but not people", () => {
    expect(isExcluded("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com")).toBe(
      true,
    );
    expect(isExcluded("Claude Opus 5.5", "noreply@anthropic.com")).toBe(true);
    expect(isExcluded("Codex", "codex@openai.com")).toBe(true);
    expect(isExcluded("Islam Shehata", "")).toBe(false);
  });

  test("derives initials from a full name or a single handle", () => {
    expect(initialsOf("Filip Taifas")).toBe("FT");
    expect(initialsOf("edenbuilds")).toBe("ED");
  });
});
