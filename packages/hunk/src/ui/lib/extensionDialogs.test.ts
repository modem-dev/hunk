import { describe, expect, test } from "bun:test";
import { createExtensionDialogQueue } from "./extensionDialogs";

describe("createExtensionDialogQueue", () => {
  test("shows one dialog at a time and queues the rest in call order", async () => {
    const queue = createExtensionDialogQueue();
    const alpha = queue.createDialogs("alpha");
    const beta = queue.createDialogs("beta");

    const first = alpha.confirm({ title: "First?" });
    const second = beta.select({ title: "Second?", options: ["one", "two"] });
    const third = alpha.input({ title: "Third?" });

    const visible = queue.current();
    expect(visible).toMatchObject({ kind: "confirm", extensionId: "alpha", title: "First?" });

    // FIFO across extensions: beta asked second and waits, however long alpha's
    // dialog stays up.
    queue.accept(visible!.id);
    expect(await first).toBe(true);
    expect(queue.current()).toMatchObject({ kind: "select", extensionId: "beta" });

    queue.accept(queue.current()!.id, "two");
    expect(await second).toBe("two");
    expect(queue.current()).toMatchObject({ kind: "input", extensionId: "alpha" });

    queue.cancel(queue.current()!.id);
    expect(await third).toBeNull();
    expect(queue.current()).toBeNull();
  });

  test("resolves each kind's own accept and cancel values", async () => {
    const queue = createExtensionDialogQueue();
    const dialogs = queue.createDialogs("probe");

    const cancelledConfirm = dialogs.confirm({ title: "Sure?" });
    queue.cancel(queue.current()!.id);
    expect(await cancelledConfirm).toBe(false);

    const cancelledSelect = dialogs.select({ title: "Which?", options: ["a"] });
    queue.cancel(queue.current()!.id);
    expect(await cancelledSelect).toBeNull();

    const submitted = dialogs.input({ title: "Name?" });
    queue.accept(queue.current()!.id, "typed");
    expect(await submitted).toBe("typed");

    // Accepting a select or input without a value has nothing to hand back, so
    // it settles as a cancel rather than as an empty answer.
    const valueless = dialogs.select({ title: "Which?", options: ["a"] });
    queue.accept(queue.current()!.id);
    expect(await valueless).toBeNull();
  });

  test("ignores an answer aimed at a dialog that is no longer current", async () => {
    const queue = createExtensionDialogQueue();
    const dialogs = queue.createDialogs("probe");

    const first = dialogs.confirm({ title: "First?" });
    const second = dialogs.confirm({ title: "Second?" });
    const firstId = queue.current()!.id;

    queue.accept(firstId);
    expect(await first).toBe(true);

    // A repeated answer for an already-settled dialog — a held-down key, a
    // late cancel racing an accept — must not answer the queued one.
    queue.accept(firstId);
    expect(queue.current()).toMatchObject({ title: "Second?" });

    queue.cancel(queue.current()!.id);
    expect(await second).toBe(false);
  });

  test("carries defaults, body lines, and the requesting extension into the request", () => {
    const queue = createExtensionDialogQueue();
    const dialogs = queue.createDialogs("carrier");

    void dialogs.confirm({ title: "Delete?", body: "one\ntwo" });
    expect(queue.current()).toMatchObject({
      kind: "confirm",
      extensionId: "carrier",
      showAttribution: true,
      bodyLines: ["one", "two"],
      confirmLabel: "ok",
      cancelLabel: "cancel",
    });

    queue.cancel(queue.current()!.id);
    void dialogs.confirm({ title: "Delete?", confirmLabel: "delete", cancelLabel: "keep" });
    expect(queue.current()).toMatchObject({ confirmLabel: "delete", cancelLabel: "keep" });
  });

  test("can omit attribution only when the host marks the dialog as native UI", () => {
    const queue = createExtensionDialogQueue();
    const dialogs = queue.createDialogs("bundled-guide", { showAttribution: false });

    void dialogs.confirm({ title: "Welcome" });

    expect(queue.current()).toMatchObject({
      extensionId: "bundled-guide",
      showAttribution: false,
      title: "Welcome",
    });
  });

  test("strips terminal escapes out of extension-authored text", () => {
    const queue = createExtensionDialogQueue();
    const dialogs = queue.createDialogs("hostile");

    void dialogs.select({
      title: "\u001b[31mPick\u001b[0m",
      options: ["\u001b]0;pwned\u0007opt"],
    });
    expect(queue.current()).toMatchObject({ title: "Pick", options: ["opt"] });
  });

  test("sanitizes an input dialog's starting text without trimming it", () => {
    const queue = createExtensionDialogQueue();
    const dialogs = queue.createDialogs("hostile");

    // The field's starting value is extension-authored text like any other,
    // but its edge spaces are content rather than formatting noise.
    void dialogs.input({ title: "Branch", initial: " \u001b]0;pwned\u0007feature/x " });
    expect(queue.current()).toMatchObject({ kind: "input", initial: " feature/x " });
  });

  test("cancelAll drains open dialogs while the queue keeps taking new ones", async () => {
    const queue = createExtensionDialogQueue();
    const dialogs = queue.createDialogs("probe");

    const confirmed = dialogs.confirm({ title: "First?" });
    const typed = dialogs.input({ title: "Second?" });

    // A session reload replaces the review the questions were about.
    queue.cancelAll();
    expect(await confirmed).toBe(false);
    expect(await typed).toBeNull();
    expect(queue.current()).toBeNull();

    // Unlike shutdown, the queue stays open: the reloaded session can ask.
    const again = dialogs.confirm({ title: "After the reload?" });
    expect(queue.current()).toMatchObject({ title: "After the reload?" });
    queue.accept(queue.current()!.id);
    expect(await again).toBe(true);
  });

  test("refuses retained controls and cancels acceptance after their lease expires", async () => {
    const queue = createExtensionDialogQueue();
    let live = true;
    const retired = queue.createDialogs("retired", { isLive: () => live });

    const open = retired.confirm({ title: "Still current?" });
    live = false;
    queue.accept(queue.current()!.id);
    expect(await open).toBe(false);
    expect(await retired.input({ title: "Too late" })).toBeNull();
    expect(queue.current()).toBeNull();

    const replacement = queue.createDialogs("replacement", { isLive: () => true });
    const next = replacement.confirm({ title: "Current" });
    queue.accept(queue.current()!.id);
    expect(await next).toBe(true);
  });

  test("cancels the pending and queued dialogs on shutdown, and refuses later ones", async () => {
    const queue = createExtensionDialogQueue();
    const dialogs = queue.createDialogs("probe");

    const confirmed = dialogs.confirm({ title: "First?" });
    const chosen = dialogs.select({ title: "Second?", options: ["a", "b"] });

    queue.shutdown();
    expect(await confirmed).toBe(false);
    expect(await chosen).toBeNull();
    expect(queue.current()).toBeNull();

    // A handler that asks during teardown gets an immediate cancel instead of a
    // promise nothing will settle.
    expect(await dialogs.confirm({ title: "Too late?" })).toBe(false);
    expect(await dialogs.input({ title: "Too late?" })).toBeNull();
    expect(queue.current()).toBeNull();
  });

  test("notifies subscribers only when the visible dialog changes", async () => {
    const queue = createExtensionDialogQueue();
    const dialogs = queue.createDialogs("probe");
    let changes = 0;
    const unsubscribe = queue.subscribe(() => {
      changes += 1;
    });

    const first = dialogs.confirm({ title: "First?" });
    expect(changes).toBe(1);
    // Queueing behind an open dialog leaves the visible one alone.
    const second = dialogs.confirm({ title: "Second?" });
    expect(changes).toBe(1);

    queue.accept(queue.current()!.id);
    expect(changes).toBe(2);
    expect(await first).toBe(true);

    unsubscribe();
    queue.cancel(queue.current()!.id);
    expect(changes).toBe(2);
    expect(await second).toBe(false);
  });

  test("rejects a blank title and a select with no options", async () => {
    const queue = createExtensionDialogQueue();
    const dialogs = queue.createDialogs("probe");

    // Malformed arguments are a bug in the extension, not an answer from the
    // user, so they reject rather than resolving a cancel value — and nothing
    // is queued for the user to dismiss.
    await expect(dialogs.confirm({ title: "   " })).rejects.toThrow(/non-empty title/);
    await expect(dialogs.select({ title: "", options: ["a"] })).rejects.toThrow(/non-empty title/);
    await expect(dialogs.input({ title: undefined as unknown as string })).rejects.toThrow(
      /non-empty title/,
    );
    await expect(dialogs.select({ title: "Which?", options: [] })).rejects.toThrow(
      /at least one option/,
    );
    await expect(
      dialogs.select({ title: "Which?", options: [1 as unknown as string] }),
    ).rejects.toThrow(/must all be strings/);

    expect(queue.current()).toBeNull();
  });
});
