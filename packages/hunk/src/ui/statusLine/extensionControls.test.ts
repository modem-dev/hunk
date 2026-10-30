import { describe, expect, test } from "bun:test";
import {
  createExtensionPromptControls,
  createExtensionStatusLineControls,
  isExtensionStatusItemId,
} from "./extensionControls";
import { createStatusLineStore } from "./store";

describe("extension status line controls", () => {
  test("set namespaces the item under the extension id", () => {
    const store = createStatusLineStore();
    const controls = createExtensionStatusLineControls(store, "search");
    controls.set({ id: "status", spans: [{ text: "[1/3]" }], alignment: "right", priority: 2 });

    expect(store.getSnapshot().items).toEqual([
      { id: "ext:search:status", spans: [{ text: "[1/3]" }], alignment: "right", priority: 2 },
    ]);
    expect(isExtensionStatusItemId("ext:search:status")).toBe(true);
    expect(isExtensionStatusItemId("host:filter")).toBe(false);
  });

  test("clear removes only this extension's item", () => {
    const store = createStatusLineStore();
    createExtensionStatusLineControls(store, "a").set({ id: "x", spans: [{ text: "a" }] });
    createExtensionStatusLineControls(store, "b").set({ id: "x", spans: [{ text: "b" }] });
    createExtensionStatusLineControls(store, "a").clear("x");

    expect(store.getSnapshot().items.map((item) => item.id)).toEqual(["ext:b:x"]);
  });

  test("controls become inert once their owner is no longer live", () => {
    const store = createStatusLineStore();
    let live = true;
    const controls = createExtensionStatusLineControls(store, "a", () => live);
    controls.set({ id: "x", spans: [{ text: "a" }] });
    live = false;
    controls.set({ id: "y", spans: [{ text: "b" }] });
    controls.clear("x");

    expect(store.getSnapshot().items.map((item) => item.id)).toEqual(["ext:a:x"]);
  });

  test("malformed items throw and leave the store untouched", () => {
    const store = createStatusLineStore();
    const controls = createExtensionStatusLineControls(store, "a");

    expect(() => controls.set({ id: "", spans: [] })).toThrow(/non-empty id/);
    expect(() => controls.set({ id: "x", spans: "nope" as never })).toThrow(/spans/);
    expect(() => controls.set({ id: "x", spans: [{ text: 3 as never }] })).toThrow(/text/);
    expect(() => controls.set({ id: "x", spans: [{ text: "ok", tone: "bad" as never }] })).toThrow(
      /tone/,
    );
    expect(() =>
      controls.set({ id: "x", spans: [{ text: "ok", attributes: ["shiny" as never] }] }),
    ).toThrow(/attributes/);
    expect(() => controls.set({ id: "x", spans: [], alignment: "center" as never })).toThrow(
      /alignment/,
    );
    expect(() => controls.set({ id: "x", spans: [], priority: "high" as never })).toThrow(
      /priority/,
    );
    expect(() => controls.clear(3 as never)).toThrow(/non-empty id/);
    expect(store.getSnapshot().items).toEqual([]);
  });

  test("set copies spans so later mutation by the extension cannot change the row", () => {
    const store = createStatusLineStore();
    const spans = [{ text: "one" }];
    createExtensionStatusLineControls(store, "a").set({ id: "x", spans });
    spans[0]!.text = "two";
    spans.push({ text: "three" });

    expect(store.getSnapshot().items[0]?.spans).toEqual([{ text: "one" }]);
  });
});

describe("extension prompt controls", () => {
  test("line opens an attributed prompt and resolves what the user submits", async () => {
    const store = createStatusLineStore();
    const controls = createExtensionPromptControls(store, "search", { showAttribution: true });
    const answer = controls.line({ prefix: "/", placeholder: "pattern", initial: "x" });

    expect(store.getSnapshot().prompt).toMatchObject({
      prefix: "/",
      placeholder: "pattern",
      value: "x",
      attribution: "ext search",
    });
    store.updatePromptValue(1, "needle");
    store.submitPrompt(1);
    expect(await answer).toBe("needle");
  });

  test("bundled extensions omit the attribution marker", () => {
    const store = createStatusLineStore();
    void createExtensionPromptControls(store, "hunk", { showAttribution: false }).line({});

    expect(store.getSnapshot().prompt?.attribution).toBeNull();
  });

  test("line rejects malformed options instead of opening", async () => {
    const store = createStatusLineStore();
    const controls = createExtensionPromptControls(store, "a", { showAttribution: true });

    await expect(controls.line(null as never)).rejects.toThrow(/options object/);
    await expect(controls.line({ prefix: 3 as never })).rejects.toThrow(/prefix/);
    await expect(controls.line({ onChange: "no" as never })).rejects.toThrow(/onChange/);
    expect(store.getSnapshot().prompt).toBeNull();
  });

  test("line resolves null once the owner is no longer live", async () => {
    const store = createStatusLineStore();
    const controls = createExtensionPromptControls(store, "a", {
      isLive: () => false,
      showAttribution: true,
    });

    expect(await controls.line({ prefix: "/" })).toBeNull();
    expect(store.getSnapshot().prompt).toBeNull();
  });

  test("a throwing onChange warns once, attributed", () => {
    const store = createStatusLineStore();
    const warnings: string[] = [];
    void createExtensionPromptControls(store, "a", {
      showAttribution: true,
      warn: (message) => warnings.push(message),
    }).line({
      onChange: () => {
        throw new Error("boom");
      },
    });
    store.updatePromptValue(1, "x");
    store.updatePromptValue(1, "xy");

    expect(warnings).toEqual(["Extension a prompt onChange failed • boom"]);
  });
});
