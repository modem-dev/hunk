import { describe, expect, test } from "bun:test";
import { describeFeedbackDisclosure } from "../../../core/feedback/payload";
import { feedbackDisclosureRows, planFeedbackDialogRows } from "./FeedbackDialog";

const environment = { version: "0.24.1", platform: "darwin" };

/** Plan the dialog for one terminal height with the widest body the modal uses. */
function planTestFeedbackDialog(terminalHeight: number, bodyWidth = 92) {
  return planFeedbackDialogRows({
    disclosure: feedbackDisclosureRows(environment, true, bodyWidth),
    compactDisclosure: feedbackDisclosureRows(environment, true, bodyWidth, true),
    statusRows: 1,
    terminalHeight,
  });
}

describe("feedback dialog row plan", () => {
  test("always keeps every word of the disclosure", () => {
    const words = describeFeedbackDisclosure({ ...environment, includesEmail: true })
      .join(" ")
      .split(/\s+/);

    for (const height of [20, 24, 32, 48]) {
      const rendered = planTestFeedbackDialog(height)
        .disclosure.join(" ")
        .replace("⚠", "")
        .split(/\s+/)
        .filter(Boolean);
      expect(rendered).toEqual(words);
    }
  });

  test("fits a 32-row terminal by compacting before anything else is dropped", () => {
    const tall = planTestFeedbackDialog(48);
    expect(tall.disclosure).toContain("");
    expect(tall.showIssuesHint).toBe(true);
    expect(tall.messageRows).toBe(5);

    const normal = planTestFeedbackDialog(32);
    expect(normal.height).toBeLessThanOrEqual(30);
    expect(normal.messageRows).toBeGreaterThanOrEqual(2);
  });

  test("drops the issues hint only after the paragraph gaps", () => {
    const short = planTestFeedbackDialog(26);

    expect(short.disclosure).not.toContain("");
    expect(short.showIssuesHint).toBe(false);
  });
});
