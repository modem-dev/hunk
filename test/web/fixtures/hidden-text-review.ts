/**
 * Writes a git repository whose staged changes carry hidden-character spoofing: a "Trojan
 * Source" (CVE-2021-42574) JavaScript file whose bidi overrides make code read as a comment, a
 * file whose name uses a right-to-left override to fake its extension, zero-width characters in
 * a path and an identifier, and legitimate Hebrew and Arabic text that must render untouched.
 *
 * Every hidden character is written as an escape so this source stays readable.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reviewOrderSidecarPath } from "./rich-review";

/** The bidi file's path, its spoofed-extension file, the zero-width file, and the RTL file. */
export const HIDDEN_TEXT_PATHS = {
  bidi: "src/bidi.js",
  spoofed: "file\u202Etxt.exe",
  zeroWidth: "src/zero\u200Bwidth.js",
  rtl: "src/greeting.js",
} as const;

/** The Trojan Source line: it reads as one comment, but `if (isAdmin)` sits outside it. */
export const TROJAN_SOURCE_LINE =
  "  /*\u202E } \u2066if (isAdmin)\u2069 \u2066 begin admins only */";

/** An identifier with a zero-width space inside it. */
export const ZERO_WIDTH_LINE = "export const is\u200BAdmin = true;";

/** Legitimate right-to-left text with no control characters. */
export const RTL_LINE = 'export const greeting = "שלום עולם"; // مرحبا بالعالم';

/** The agent note on the bidi file, whose summary carries an override of its own. */
export const HIDDEN_TEXT_NOTE_SUMMARY = "Looks safe: admin\u202E check";

/** Run one git command in the test repository with a fixed identity and no user config. */
function git(repo: string, ...args: string[]) {
  execFileSync(
    "git",
    ["-c", "user.name=Hunk Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd: repo, stdio: "ignore" },
  );
}

/** Write one file, creating its directories. */
function writeTestFile(repo: string, path: string, contents: string) {
  const target = join(repo, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/** Build the hidden-text review's repository at `repo` and stage its changes. */
export function writeHiddenTextReviewRepo(repo: string) {
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeTestFile(
    repo,
    HIDDEN_TEXT_PATHS.bidi,
    'function check(isAdmin) {\n  console.log("checking");\n}\n',
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");

  writeTestFile(
    repo,
    HIDDEN_TEXT_PATHS.bidi,
    [
      "function check(isAdmin) {",
      TROJAN_SOURCE_LINE,
      '  console.log("You are an admin.");',
      "  /* end admins only \u202E { \u2066*/",
      "}",
      "",
    ].join("\n"),
  );
  writeTestFile(repo, HIDDEN_TEXT_PATHS.spoofed, "not really a text file\n");
  writeTestFile(repo, HIDDEN_TEXT_PATHS.zeroWidth, `${ZERO_WIDTH_LINE}\n`);
  writeTestFile(repo, HIDDEN_TEXT_PATHS.rtl, `${RTL_LINE}\n`);
  git(repo, "add", "-A");
  writeFileSync(
    reviewOrderSidecarPath(repo),
    JSON.stringify({
      version: 1,
      files: [
        {
          path: HIDDEN_TEXT_PATHS.bidi,
          annotations: [
            { newRange: [2, 2], summary: HIDDEN_TEXT_NOTE_SUMMARY, author: "agent\u200Bbot" },
          ],
        },
        { path: HIDDEN_TEXT_PATHS.spoofed },
        { path: HIDDEN_TEXT_PATHS.zeroWidth },
        { path: HIDDEN_TEXT_PATHS.rtl },
      ],
    }),
  );
}
