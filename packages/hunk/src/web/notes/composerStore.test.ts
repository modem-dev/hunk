import { describe, expect, test } from "bun:test";
import { NoteComposerStore, noteComposerKey, noteDraftStorageKey } from "./composerStore";

/** An in-memory `sessionStorage` stand-in. */
function createTestStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const NEW_NOTE = {
  kind: "new" as const,
  fileKey: "file:a",
  hunkIndex: 0,
  side: "new" as const,
  line: 12,
  contentIdentity: "content:a",
};

describe("NoteComposerStore", () => {
  test("keeps one composer per anchor and several across anchors", () => {
    const store = new NoteComposerStore("s1", createTestStorage());
    const first = store.open(NEW_NOTE);
    expect(store.open(NEW_NOTE)).toBe(first);
    store.open({ ...NEW_NOTE, line: 14 });
    store.open({ ...NEW_NOTE, kind: "reply", parentId: "note-1" });

    expect(store.getSnapshot().map((composer) => composer.key)).toEqual([
      first,
      noteComposerKey({ ...NEW_NOTE, line: 14 }),
      noteComposerKey({ ...NEW_NOTE, kind: "reply", parentId: "note-1" }),
    ]);
  });

  test("restores unsent drafts in a new page and forgets closed ones", () => {
    const storage = createTestStorage();
    const store = new NoteComposerStore("s1", storage);
    const key = store.open(NEW_NOTE);
    store.update(key, { body: "half written" });

    const reloaded = new NoteComposerStore("s1", storage);
    expect(reloaded.getSnapshot()).toMatchObject([
      { key, body: "half written", status: "editing" },
    ]);
    expect(new NoteComposerStore("s2", storage).getSnapshot()).toEqual([]);

    reloaded.close(key);
    expect(storage.values.has(noteDraftStorageKey("s1"))).toBe(false);
  });

  test("does not persist a composer that is sending", () => {
    const storage = createTestStorage();
    const store = new NoteComposerStore("s1", storage);
    const key = store.open(NEW_NOTE);
    store.update(key, { body: "sent", status: "sending" });
    expect(new NoteComposerStore("s1", storage).getSnapshot()).toEqual([]);
  });

  test("ignores malformed drafts", () => {
    const storage = createTestStorage();
    storage.setItem(noteDraftStorageKey("s1"), JSON.stringify([{ kind: "new" }, 3]));
    expect(new NoteComposerStore("s1", storage).getSnapshot()).toEqual([]);
    storage.setItem(noteDraftStorageKey("s1"), "{not json");
    expect(new NoteComposerStore("s1", storage).getSnapshot()).toEqual([]);
  });

  test("marks a draft whose file content changed or disappeared", () => {
    const store = new NoteComposerStore("s1", createTestStorage());
    const kept = store.open(NEW_NOTE);
    const moved = store.open({ ...NEW_NOTE, fileKey: "file:b", contentIdentity: "content:b" });
    const gone = store.open({ ...NEW_NOTE, fileKey: "file:c", contentIdentity: "content:c" });
    store.reconcileContent(
      new Map([
        ["file:a", "content:a"],
        ["file:b", "content:b2"],
      ]),
    );

    const status = new Map(store.getSnapshot().map((composer) => [composer.key, composer.status]));
    expect([status.get(kept), status.get(moved), status.get(gone)]).toEqual([
      "editing",
      "changed",
      "editing",
    ]);
  });

  test("closes a sent composer once the shared state reaches its position", () => {
    const store = new NoteComposerStore("s1", createTestStorage());
    const key = store.open(NEW_NOTE);
    store.update(key, { status: "sending", awaiting: { generation: "g1", stateRevision: 5 } });

    store.settleSent({ generation: "g1", stateRevision: 4 });
    expect(store.getSnapshot()).toHaveLength(1);
    store.settleSent({ generation: "g1", stateRevision: 5 });
    expect(store.getSnapshot()).toHaveLength(0);
  });
});
