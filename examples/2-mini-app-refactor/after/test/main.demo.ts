import { expect, test } from "bun:test";
import { renderMorningSummary } from "../src/main";

test("renders grouped sections for the morning summary", () => {
  const output = renderMorningSummary();

  expect(output).toContain("Shipping today");
  expect(output).toContain("[active] Polish dashboard empty state");
  expect(output).toContain("Needs help");
  expect(output).toContain("[blocked] Document keyboard shortcuts");
});
