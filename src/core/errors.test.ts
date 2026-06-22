import { afterEach, describe, expect, test } from "bun:test";
import { formatCliError, HunkUserError } from "./errors";

const originalDebug = process.env.HUNK_DEBUG;

afterEach(() => {
  if (originalDebug === undefined) {
    delete process.env.HUNK_DEBUG;
  } else {
    process.env.HUNK_DEBUG = originalDebug;
  }
});

describe("formatCliError", () => {
  test("formats expected user errors with optional details and no stack", () => {
    expect(formatCliError(new HunkUserError("Not in a repo"))).toBe("hunk: Not in a repo\n");
    expect(formatCliError(new HunkUserError("Invalid ref", ["Try `HEAD~1`."]))).toBe(
      "hunk: Invalid ref\n\nTry `HEAD~1`.\n",
    );
  });

  test("hides unexpected stacks unless debug output is explicitly enabled", () => {
    const error = new Error("Boom");
    error.stack = "Error: Boom\n    at internal";

    delete process.env.HUNK_DEBUG;
    expect(formatCliError(error)).toBe("hunk: Boom\n");

    process.env.HUNK_DEBUG = "1";
    expect(formatCliError(error)).toBe("Error: Boom\n    at internal\n");
  });

  test("stringifies non-error thrown values", () => {
    expect(formatCliError("plain failure")).toBe("hunk: plain failure\n");
  });
});
