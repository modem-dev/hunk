import { expect, test } from "bun:test";
import { themeFollowsTerminal } from "./terminalColors";

test("only explicit terminal and auto themes need terminal color detection", () => {
  expect(themeFollowsTerminal(undefined)).toBe(false);
  expect(themeFollowsTerminal("github-dark-default")).toBe(false);
  expect(themeFollowsTerminal("github-light-default")).toBe(false);
  expect(themeFollowsTerminal("terminal")).toBe(true);
  expect(themeFollowsTerminal("auto")).toBe(true);
});
