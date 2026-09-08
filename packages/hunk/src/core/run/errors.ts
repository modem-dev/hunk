import { HUNK_EXTENSION_USER_ERROR_NAME, HunkExtensionUserError } from "../../extension-api/types";

/**
 * A failure Hunk raises because of how it was invoked, not because of a bug.
 *
 * This is the published `HunkExtensionUserError` under Hunk's own name, so host
 * code and extension code raise one thing rather than two parallel ones: the
 * CLI formatter, the adapter boundary, and a third-party VCS backend all agree
 * on what a user-facing failure looks like.
 */
export class HunkUserError extends HunkExtensionUserError {
  constructor(message: string, suggestions: string[] = []) {
    super(message, { suggestions });
    this.name = "HunkUserError";
  }
}

/** One error carrying the published user-facing shape, however it was constructed. */
interface UserFacingErrorShape {
  message: string;
  suggestions?: unknown;
}

/**
 * Report whether a value carries the published user-error shape.
 *
 * Detection is structural, not `instanceof`: an extension may ship its own copy
 * of the class, or be plain JavaScript that only sets `name` and `suggestions`,
 * and either must still reach the user as a clean message instead of a stack.
 */
export function isUserFacingError(error: unknown): error is UserFacingErrorShape {
  if (error instanceof HunkExtensionUserError) {
    return true;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === HUNK_EXTENSION_USER_ERROR_NAME &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

/** Read a suggestion list defensively; an extension may hand back anything. */
function readSuggestions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Normalize whatever an extension threw into Hunk's own user-facing error.
 *
 * Errors that do not carry the published shape pass through untouched, so a
 * genuine bug in an adapter still surfaces as an unexpected error with its
 * stack intact.
 */
export function toUserFacingError(error: unknown): unknown {
  if (error instanceof HunkUserError) {
    return error;
  }

  if (isUserFacingError(error)) {
    return new HunkUserError(error.message, readSuggestions(error.suggestions));
  }

  return error;
}

/** Format CLI and startup failures without exposing Bun internal stack frames for expected errors. */
export function formatCliError(error: unknown) {
  if (isUserFacingError(error)) {
    const lines = [`hunk: ${error.message}`];
    const suggestions = readSuggestions(error.suggestions);

    if (suggestions.length > 0) {
      lines.push("", ...suggestions);
    }

    return `${lines.join("\n")}\n`;
  }

  if (error instanceof Error) {
    if (process.env.HUNK_DEBUG === "1" && error.stack) {
      return `${error.stack}\n`;
    }

    return `hunk: ${error.message}\n`;
  }

  return `hunk: ${String(error)}\n`;
}
