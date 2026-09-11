import { describe, expect, test } from "bun:test";
import { createStatusLineStore } from "./store";

describe("status line store items", () => {
  test("set adds an item in set order and replaces it in place", () => {
    const store = createStatusLineStore();
    store.setItem({ id: "a", spans: [{ text: "one" }] });
    store.setItem({ id: "b", spans: [{ text: "two" }] });
    store.setItem({ id: "a", spans: [{ text: "uno" }] });

    expect(store.getSnapshot().items.map((item) => item.spans[0]?.text)).toEqual(["uno", "two"]);
  });

  test("clear removes an item and forgets its slot", () => {
    const store = createStatusLineStore();
    store.setItem({ id: "a", spans: [{ text: "one" }] });
    store.setItem({ id: "b", spans: [{ text: "two" }] });
    store.clearItem("a");
    store.setItem({ id: "a", spans: [{ text: "again" }] });

    expect(store.getSnapshot().items.map((item) => item.id)).toEqual(["b", "a"]);
  });

  test("clearItems removes every item the predicate matches", () => {
    const store = createStatusLineStore();
    store.setItem({ id: "ext:a", spans: [{ text: "one" }] });
    store.setItem({ id: "host:b", spans: [{ text: "two" }] });
    store.setItem({ id: "ext:c", spans: [{ text: "three" }] });
    store.clearItems((id) => id.startsWith("ext:"));

    expect(store.getSnapshot().items.map((item) => item.id)).toEqual(["host:b"]);
  });

  test("snapshot identity is stable between writes and changes on every write", () => {
    const store = createStatusLineStore();
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    store.setItem({ id: "a", spans: [{ text: "one" }] });
    expect(store.getSnapshot()).not.toBe(before);
  });

  test("subscribers are notified on item writes", () => {
    const store = createStatusLineStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    store.setItem({ id: "a", spans: [{ text: "one" }] });
    store.clearItem("a");
    unsubscribe();
    store.setItem({ id: "a", spans: [{ text: "one" }] });

    expect(notified).toBe(2);
  });
});

describe("status line store prompts", () => {
  test("requesting a prompt makes it current with its normalized options", () => {
    const store = createStatusLineStore();
    void store.requestPrompt({ prefix: "/", placeholder: "pattern", initial: "foo" });

    expect(store.getSnapshot().prompt).toEqual({
      id: 1,
      prefix: "/",
      placeholder: "pattern",
      value: "foo",
      attribution: null,
    });
  });

  test("submit resolves the live value and promotes the next queued prompt", async () => {
    const store = createStatusLineStore();
    const first = store.requestPrompt({ prefix: "/" });
    const second = store.requestPrompt({ prefix: ":" });
    expect(store.getSnapshot().prompt?.prefix).toBe("/");

    store.updatePromptValue(1, "needle");
    store.submitPrompt(1);
    expect(await first).toBe("needle");
    expect(store.getSnapshot().prompt?.prefix).toBe(":");

    store.cancelPrompt(2);
    expect(await second).toBeNull();
    expect(store.getSnapshot().prompt).toBeNull();
  });

  test("updatePromptValue reports every edit through onChange", () => {
    const store = createStatusLineStore();
    const seen: string[] = [];
    void store.requestPrompt({ onChange: (value) => seen.push(value) });
    store.updatePromptValue(1, "a");
    store.updatePromptValue(1, "ab");

    expect(seen).toEqual(["a", "ab"]);
    expect(store.getSnapshot().prompt?.value).toBe("ab");
  });

  test("a throwing onChange warns once and the prompt continues", () => {
    const store = createStatusLineStore();
    const warnings: string[] = [];
    void store.requestPrompt(
      {
        onChange: () => {
          throw new Error("boom");
        },
      },
      { onChangeFailed: (detail) => warnings.push(detail) },
    );
    store.updatePromptValue(1, "a");
    store.updatePromptValue(1, "ab");

    expect(warnings).toEqual(["boom"]);
    expect(store.getSnapshot().prompt?.value).toBe("ab");
  });

  test("answers for a prompt that is not current are ignored", async () => {
    const store = createStatusLineStore();
    const first = store.requestPrompt({});
    void store.requestPrompt({});
    store.submitPrompt(2);
    store.updatePromptValue(2, "late");

    expect(store.getSnapshot().prompt?.id).toBe(1);
    store.submitPrompt(1);
    expect(await first).toBe("");
  });

  test("cancelAllPrompts settles open and queued prompts with null and keeps the store open", async () => {
    const store = createStatusLineStore();
    const first = store.requestPrompt({});
    const second = store.requestPrompt({});
    store.cancelAllPrompts();

    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(store.getSnapshot().prompt).toBeNull();
    void store.requestPrompt({ prefix: "again" });
    expect(store.getSnapshot().prompt?.prefix).toBe("again");
  });

  test("reload preserves opted-in host prompts and cancels other open and queued prompts", async () => {
    const store = createStatusLineStore();
    const extension = store.requestPrompt({});
    const host = store.openPrompt({ prefix: "filter:" }, { surviveReload: true });
    const queued = store.requestPrompt({});
    store.cancelReloadPrompts();

    expect(await extension).toBeNull();
    expect(await queued).toBeNull();
    expect(store.getSnapshot().prompt?.id).toBe(host.id!);
    store.updatePromptValue(host.id!, "after");
    const prompt = store.getSnapshot().prompt;
    store.cancelReloadPrompts();
    expect(store.getSnapshot().prompt).toBe(prompt);
    store.shutdown();
    expect(await host.answer).toBeNull();
  });

  test("shutdown settles pending prompts and refuses later ones immediately", async () => {
    const store = createStatusLineStore();
    const first = store.requestPrompt({});
    store.shutdown();
    expect(await first).toBeNull();
    expect(await store.requestPrompt({ prefix: "/" })).toBeNull();
    expect(store.getSnapshot().prompt).toBeNull();
  });

  test("a prompt whose owner is no longer live resolves null without appearing", async () => {
    const store = createStatusLineStore();
    const answer = store.requestPrompt({}, { isLive: () => false });
    expect(store.getSnapshot().prompt).toBeNull();
    expect(await answer).toBeNull();
  });

  test("submitting a prompt whose owner expired while open resolves null", async () => {
    const store = createStatusLineStore();
    let live = true;
    const answer = store.requestPrompt({}, { isLive: () => live });
    store.updatePromptValue(1, "typed");
    live = false;
    store.submitPrompt(1);
    expect(await answer).toBeNull();
  });

  test("attribution and sanitized text are carried on the request", () => {
    const store = createStatusLineStore();
    void store.requestPrompt(
      { prefix: "/\u001b[31m", placeholder: "p\u0007", initial: "x\u001b[0m" },
      { attribution: "ext search" },
    );

    expect(store.getSnapshot().prompt).toMatchObject({
      prefix: "/",
      placeholder: "p",
      value: "x",
      attribution: "ext search",
    });
  });

  test("subscribers are notified only when the visible prompt changes", () => {
    const store = createStatusLineStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    void store.requestPrompt({});
    expect(notified).toBe(1);
    void store.requestPrompt({});
    expect(notified).toBe(1);
    store.updatePromptValue(1, "a");
    expect(notified).toBe(2);
    store.submitPrompt(1);
    expect(notified).toBe(3);
  });
});
