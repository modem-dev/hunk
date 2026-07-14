import { describe, expect, test } from "bun:test";
import { parseGitTrace2, sanitizeGitArgv } from "./git-log";

describe("watch Git Trace2 activity", () => {
  test("groups commands without retaining paths, URLs, or config values", () => {
    expect(
      sanitizeGitArgv([
        "/usr/bin/git",
        "-c",
        "credential.helper=secret",
        "diff",
        "--no-ext-diff",
        "--",
        "/Users/person/private/repo/file.ts",
      ]),
    ).toEqual({ family: "diff", arguments: ["--no-ext-diff", "--", "<pathspec>"] });
    expect(sanitizeGitArgv(["git.exe", "rev-parse", "HEAD"]).family).toBe("rev-parse");
    expect(
      JSON.stringify(sanitizeGitArgv(["git", "fetch", "https://token@example.invalid/repo"])),
    ).not.toContain("token");
  });

  test("parses only start events and counts malformed JSON or argv", () => {
    const parsed = parseGitTrace2(
      [
        JSON.stringify({ event: "version", time: "2026-07-14T00:00:00.000Z" }),
        JSON.stringify({
          event: "start",
          time: "2026-07-14T00:00:01.000Z",
          argv: ["git", "status", "--short"],
        }),
        "not-json",
        JSON.stringify({ event: "start", time: "bad-time", argv: ["git", "diff"] }),
      ].join("\n"),
    );
    expect(parsed.commands).toEqual([
      {
        timestamp: "2026-07-14T00:00:01.000Z",
        family: "status",
        arguments: ["--short"],
      },
    ]);
    expect(parsed.malformedLineCount).toBe(2);
  });
});
