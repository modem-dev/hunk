import { describe, expect, test } from "bun:test";
import {
  isInlineStmlRole,
  isRawTextStmlTag,
  isVoidStmlTag,
  stmlTagRole,
  type StmlTagRole,
} from "./stml";

describe("stmlTagRole", () => {
  test("collapses aliases onto one role so renderers cannot treat them differently", () => {
    const aliases: Array<[string[], StmlTagRole]> = [
      [["b", "strong"], "strong"],
      [["i", "em"], "emphasis"],
      [["s", "strike", "del"], "strike"],
      [["dim", "muted"], "muted"],
      [["a", "link"], "link"],
      [["c", "color", "span"], "styled"],
      [["box", "col", "column", "stack", "section"], "container"],
      [["text", "p"], "paragraph"],
      [["h", "h2", "h3", "heading"], "heading"],
      [["h1", "title"], "title"],
      [["hr", "rule", "divider"], "divider"],
      [["spacer", "space"], "spacer"],
      [["list", "ul"], "list"],
      [["item", "li"], "list-item"],
      [["code", "pre"], "code"],
    ];

    for (const [tags, role] of aliases) {
      for (const tag of tags) {
        expect(stmlTagRole(tag)).toBe(role);
      }
    }
  });

  test("keeps the tags whose rendering genuinely differs apart", () => {
    expect(stmlTagRole("card")).toBe("card");
    expect(stmlTagRole("ol")).toBe("ordered-list");
    expect(stmlTagRole("kbd")).toBe("key");
    expect(stmlTagRole("badge")).toBe("badge");
  });

  test("reports an unknown tag as unknown rather than guessing a role", () => {
    expect(stmlTagRole("marquee")).toBeUndefined();
    expect(stmlTagRole("tag")).toBeUndefined();
  });
});

describe("role classification", () => {
  test("separates inline flow from block layout", () => {
    expect(isInlineStmlRole(stmlTagRole("strong"))).toBe(true);
    expect(isInlineStmlRole(stmlTagRole("br"))).toBe(true);
    // The terminal layout engine partitions inline runs through this predicate,
    // so the color tags it flows inline have to classify as inline here too.
    for (const tag of ["c", "color", "span"]) {
      expect(isInlineStmlRole(stmlTagRole(tag))).toBe(true);
    }
    expect(isInlineStmlRole(stmlTagRole("card"))).toBe(false);
    expect(isInlineStmlRole(undefined)).toBe(false);
  });

  test("derives the parser's void tags from roles", () => {
    for (const tag of ["br", "hr", "rule", "divider", "spacer", "space"]) {
      expect(isVoidStmlTag(tag)).toBe(true);
    }
    expect(isVoidStmlTag("card")).toBe(false);
    expect(isVoidStmlTag("unknown")).toBe(false);
  });

  test("derives the parser's raw-text tags from roles", () => {
    expect(isRawTextStmlTag("code")).toBe(true);
    expect(isRawTextStmlTag("pre")).toBe(true);
    expect(isRawTextStmlTag("p")).toBe(false);
  });
});
