import { describe, expect, test } from "bun:test";
import type { ExtensionNotification } from "../../extensions/notifications";
import {
  enqueueExtensionNotification,
  EXTENSION_TOAST_QUEUE_LIMIT,
  extensionToastMessage,
} from "./extensionNotifications";

/** Build one notification with a predictable id for queue assertions. */
function createTestNotification(id: number): ExtensionNotification {
  return { id, message: `message ${id}`, type: "info" };
}

describe("extension toast message", () => {
  test("collapses whitespace and keeps a short message intact", () => {
    expect(extensionToastMessage("  loaded\n  3   files \t", 80)).toBe("loaded 3 files");
  });

  test("truncates at the width left over after the toast chrome", () => {
    // 20 columns minus the "ext" prefix, its separator, and the row padding.
    const message = "x".repeat(40);

    const fitted = extensionToastMessage(message, 20);

    expect(fitted).toBe(`${"x".repeat(13)}…`);
    expect(fitted.length).toBe(14);
  });

  test("keeps a message exactly at the boundary untruncated", () => {
    const available = 30 - "ext".length - 3;

    expect(extensionToastMessage("y".repeat(available), 30)).toBe("y".repeat(available));
    expect(extensionToastMessage("y".repeat(available + 1), 30)).toEndWith("…");
  });

  test("never shrinks below a readable floor on a very narrow terminal", () => {
    expect(extensionToastMessage("z".repeat(40), 4)).toBe(`${"z".repeat(7)}…`);
  });

  test("strips terminal control sequences from extension-authored text", () => {
    const hostile = "\x1b[2Jcleared\x1b]0;retitled\x07 \x1b[31mred\x1b[0m";

    const fitted = extensionToastMessage(hostile, 200);

    expect(fitted).toBe("cleared red");
    expect(fitted).not.toContain("\x1b");
  });

  test("strips C1 control sequences and stray control bytes", () => {
    expect(extensionToastMessage("before\x9b31mafter\x00", 200)).toBe("beforeafter");
  });
});

describe("extension toast queue", () => {
  test("appends newest last", () => {
    const queue = enqueueExtensionNotification(
      [createTestNotification(1)],
      createTestNotification(2),
    );

    expect(queue.map((entry) => entry.id)).toEqual([1, 2]);
  });

  test("drops the oldest pending notifications once the cap is reached", () => {
    let queue: ExtensionNotification[] = [];
    for (let id = 1; id <= EXTENSION_TOAST_QUEUE_LIMIT + 3; id++) {
      queue = enqueueExtensionNotification(queue, createTestNotification(id));
    }

    // A looping extension costs the user one stale row, not an unbounded backlog.
    expect(queue).toHaveLength(EXTENSION_TOAST_QUEUE_LIMIT);
    expect(queue[0]?.id).toBe(4);
    expect(queue.at(-1)?.id).toBe(EXTENSION_TOAST_QUEUE_LIMIT + 3);
  });

  test("returns a new array instead of mutating the current queue", () => {
    const current = [createTestNotification(1)];

    const next = enqueueExtensionNotification(current, createTestNotification(2));

    expect(current).toHaveLength(1);
    expect(next).not.toBe(current);
  });
});
