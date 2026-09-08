import { supportsHighlightWorkerOffload } from "../../../highlightWorkerClient";
import type { AppTheme } from "../../themes";
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
      reason: "invalid-document" | "runtime-unavailable" | "custom-theme";
      issue: string;
    };

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
