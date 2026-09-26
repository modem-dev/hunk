import { describe, expect, test } from "bun:test";
import { measureTextWidth } from "../lib/text";
import { layoutStatusLine, type StatusLineLayoutInput } from "./layout";
import type { StatusItem } from "./types";

function item(
  id: string,
  text: string,
  options: Partial<Pick<StatusItem, "alignment" | "priority">> = {},
): StatusItem {
  return { id, spans: [{ text }], ...options };
}

function layout(overrides: Partial<StatusLineLayoutInput>) {
  return layoutStatusLine({ items: [], prompt: null, badge: null, width: 80, ...overrides });
}

function placedText(placed: readonly { spans: readonly { text: string }[] }[]) {
  return placed.map((entry) => entry.spans.map((span) => span.text).join(""));
}

describe("layoutStatusLine", () => {
  test("places left items in set order and right items beside the badge", () => {
    const result = layout({
      items: [
        item("a", "filter=foo"),
        item("b", "3 viewed", { alignment: "right" }),
        item("c", "note"),
      ],
      badge: "Search — Esc exits",
    });

    expect(placedText(result.left)).toEqual(["filter=foo", "note"]);
    expect(placedText(result.right)).toEqual(["3 viewed"]);
    expect(result.badge).toEqual({ text: "Search — Esc exits", width: 20 });
    expect(result.prompt).toBeNull();
  });

  test("an item with no spans contributes nothing", () => {
    const result = layout({ items: [{ id: "a", spans: [] }, item("b", "shown")] });

    expect(placedText(result.left)).toEqual(["shown"]);
  });

  test("a prompt takes the left region and keeps right items and the badge", () => {
    const result = layout({
      items: [item("a", "filter=foo"), item("b", "3 viewed", { alignment: "right" })],
      prompt: { prefix: "/", attribution: null },
      badge: "Mode",
      width: 40,
    });

    expect(result.left).toEqual([]);
    expect(placedText(result.right)).toEqual(["3 viewed"]);
    // 40 − 2 padding − badge (6) − 1 gap − right (8) − 2 gap − prefix (1) − 1 space = 19.
    expect(result.prompt).toEqual({ prefix: "/", attribution: null, inputWidth: 19 });
  });

  test("a prompt paints its attribution before the prefix", () => {
    const result = layout({ prompt: { prefix: "/", attribution: "ext search" }, width: 30 });

    expect(result.prompt).toEqual({ prefix: "/", attribution: "ext search", inputWidth: 15 });
  });

  test("a narrow prompt drops right items before starving the input", () => {
    const result = layout({
      items: [item("b", "some right-aligned status", { alignment: "right" })],
      prompt: { prefix: "filter:", attribution: null },
      width: 20,
    });

    expect(result.right).toEqual([]);
    // 20 − 2 padding − prefix (7) − 1 space = 10.
    expect(result.prompt?.inputWidth).toBe(10);
  });

  test.each([
    { prefix: "a very long prompt prefix:", attribution: null },
    { prefix: "検索:", attribution: "ext 非常に長い拡張機能" },
  ])("truncates a long prompt lead-in before starving the input beside a badge: %j", (prompt) => {
    const result = layout({ prompt, badge: "Mode", width: 20 });
    const lead = [result.prompt?.attribution, result.prompt?.prefix].filter(Boolean).join(" ");
    expect(lead).toEndWith("…");
    expect(result.prompt?.inputWidth).toBeGreaterThanOrEqual(4);
    expect(result.badge).toEqual({ text: "Mode", width: 6 });
    expect(
      2 + measureTextWidth(lead) + 1 + result.prompt!.inputWidth + 1 + result.badge!.width,
    ).toBeLessThanOrEqual(20);
    expect(layout({ prompt, badge: "Mode", width: 20 })).toEqual(result);
  });

  test("an impossibly narrow row uses only the input cells actually available beside the badge", () => {
    const result = layout({
      prompt: { prefix: "filter:", attribution: null },
      badge: "Mode",
      width: 10,
    });
    expect(result.prompt).toEqual({ prefix: "", attribution: null, inputWidth: 1 });
    expect(result.badge).toEqual({ text: "Mode", width: 6 });
  });

  test("a short row truncates the prefix to reserve four input cells", () => {
    const result = layout({ prompt: { prefix: "filter:", attribution: null }, width: 8 });

    expect(result.prompt).toEqual({ prefix: "…", attribution: null, inputWidth: 4 });
  });

  test("overflow drops the lowest-priority item whole, newest first among equals", () => {
    const result = layout({
      items: [
        item("keep", "important", { priority: 2 }),
        item("first", "aaaaaaaaaa", { priority: 0 }),
        item("second", "bbbbbbbbbb", { priority: 0 }),
      ],
      width: 2 + 9 + 2 + 10 + 1,
    });

    expect(placedText(result.left)).toEqual(["important", "aaaaaaaaaa"]);
  });

  test("the last surviving item is truncated with an ellipsis", () => {
    const result = layout({
      items: [item("a", "abcdefghij", { priority: 0 }), item("b", "klmnopqrst", { priority: 1 })],
      width: 2 + 6,
    });

    expect(placedText(result.left)).toEqual(["klmno…"]);
    expect(result.left[0]?.width).toBe(6);
  });

  test("truncation cuts across spans and keeps their tones", () => {
    const result = layout({
      items: [
        {
          id: "a",
          spans: [
            { text: "[2/7] ", tone: "accent" },
            { text: "src/file.ts", tone: "muted" },
          ],
        },
      ],
      width: 2 + 10,
    });

    expect(result.left[0]?.spans).toEqual([
      { text: "[2/7] ", tone: "accent" },
      { text: "src…", tone: "muted" },
    ]);
  });

  test("overflow drops by priority across both alignments", () => {
    const result = layout({
      items: [
        item("left", "left status", { priority: 1 }),
        item("hint", "a long right-aligned hint", { alignment: "right", priority: 0 }),
      ],
      width: 2 + 11 + 2 + 5,
    });

    expect(placedText(result.left)).toEqual(["left status"]);
    expect(result.right).toEqual([]);
  });

  test("the badge is never dropped and is capped at half the row", () => {
    const result = layout({
      items: [item("a", "status text")],
      badge: "an extremely long keyboard mode badge text",
      width: 20,
    });

    expect(result.badge?.width).toBe(10);
    expect(placedText(result.left)).toEqual(["status…"]);
  });

  test("a wide row keeps every item without truncation", () => {
    const result = layout({
      items: [
        item("a", "left one"),
        item("b", "left two"),
        item("c", "right", { alignment: "right" }),
      ],
      badge: "Mode",
      width: 200,
    });

    expect(placedText(result.left)).toEqual(["left one", "left two"]);
    expect(result.left.map((entry) => entry.width)).toEqual([8, 8]);
    expect(placedText(result.right)).toEqual(["right"]);
  });

  test("control characters in item text are sanitized before measurement", () => {
    const result = layout({ items: [item("a", "bad\u001b[31mtext")] });

    expect(result.left[0]?.spans[0]?.text).not.toContain("\u001b");
    expect(result.left[0]?.width).toBe(result.left[0]?.spans[0]?.text.length);
  });
});
