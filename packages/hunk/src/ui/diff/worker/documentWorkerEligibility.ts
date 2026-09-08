import { supportsHighlightWorkerOffload } from "../../../highlightWorkerClient";
import type { AppTheme } from "../../themes";
import { HIGHLIGHT_WORKER_MIN_LINES } from "../highlightRenderOptions";
import { syntaxHighlightThemeName } from "../syntaxHighlightTheme";
import { describeHighlightWorkerDocumentIssue } from "./highlightWorkerProtocol";

/** Carries the exact bounded request inputs a document worker can accept. */
export interface DocumentWorkerHighlightInput {
  appearance: "dark" | "light";
  language: string;
  path: string;
  text: string;
  theme: string;
}

export type DocumentWorkerEligibility =
  | { eligible: true; input: DocumentWorkerHighlightInput }
  | {
      eligible: false;
      reason: "invalid-document" | "runtime-unavailable" | "custom-theme" | "small-document";
      issue: string;
    };

/** Count logical lines without allocating the complete split used later by Shiki. */
function documentLineCount(text: string) {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < text.length - 1; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

/**
 * Decide whether one document can use the bundled-theme worker path.
 *
 * Scope-derived custom themes stay inline because worker processes do not inherit main-thread
 * theme registration. Runtime overrides exist only for deterministic platform tests.
 */
export function documentWorkerEligibility({
  language,
  path,
  runtime,
  text,
  theme,
}: {
  language: string;
  path: string;
  runtime?: { execPath?: string; platform?: NodeJS.Platform };
  text: string;
  theme: AppTheme;
}): DocumentWorkerEligibility {
  const syntaxTheme = syntaxHighlightThemeName(theme);
  const input: DocumentWorkerHighlightInput = {
    appearance: theme.appearance,
    language,
    path,
    text,
    theme: syntaxTheme,
  };
  const issue = describeHighlightWorkerDocumentIssue(input);
  if (issue) return { eligible: false, reason: "invalid-document", issue };

  const lines = documentLineCount(text);
  if (lines < HIGHLIGHT_WORKER_MIN_LINES) {
    return {
      eligible: false,
      reason: "small-document",
      issue: `Documents below ${HIGHLIGHT_WORKER_MIN_LINES} lines highlight inline.`,
    };
  }

  if (!supportsHighlightWorkerOffload(runtime)) {
    return {
      eligible: false,
      reason: "runtime-unavailable",
      issue: "Syntax worker offload is unavailable in this runtime.",
    };
  }
  if (Object.keys(theme.syntaxScopeOverrides ?? {}).length > 0) {
    return {
      eligible: false,
      reason: "custom-theme",
      issue: "Custom syntax scope themes must be highlighted inline.",
    };
  }
  return { eligible: true, input };
}
