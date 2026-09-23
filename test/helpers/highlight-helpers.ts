import type { AppTheme } from "../../packages/hunk/src/ui/themes";
import {
  documentWorkerEligibility,
  type DocumentWorkerEligibility,
} from "../../packages/hunk/src/ui/diff/worker";

/**
 * Apply the real document eligibility policy under a runtime without worker support, so a
 * service under test keeps its inline path while still classifying invalid documents.
 */
export function inlineOnlyTestWorkerEligibility(input: {
  language: string;
  path: string;
  text: string;
  theme: AppTheme;
}): DocumentWorkerEligibility {
  return documentWorkerEligibility({
    ...input,
    runtime: { platform: "win32", execPath: "C:\\hunk\\hunk.exe" },
  });
}
