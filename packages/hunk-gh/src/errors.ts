import { HunkExtensionUserError } from "hunkdiff/extension";

/** Detects terminal control characters that user input must never carry into output. */
export function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

/** Rejects unsafe user input before it can be interpolated into terminal-visible errors. */
export function assertSafeArgument(value: string, label: string): void {
  if (hasControlCharacter(value)) {
    throw invocationError(`${label} cannot contain control characters.`);
  }
}

/** Builds a user-facing invocation error with valid forms attached. */
export function invocationError(message: string): HunkExtensionUserError {
  return new HunkExtensionUserError(message, {
    suggestions: [
      "Run `hunk gh pr --help` for accepted pull-request forms.",
      "Use `hunk gh pr 123 --repo owner/repo` outside a GitHub checkout.",
    ],
  });
}
