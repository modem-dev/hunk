import { expect, test } from "bun:test";
import { renderMorningSummary } from "../src/main";

test("renders a flat morning summary", () => {
  const output = renderMorningSummary();

  expect(output).toContain("Morning summary");
  expect(output).toContain("Document keyboard shortcuts");
});
