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

  // Intent: the backup lasts until the session accepts the save, so a refused or interrupted
  // save (the tab closed mid-request) still has its text after a reload.
  test("keeps a sending draft's backup until the session accepts it", () => {
    const storage = createTestStorage();
    const store = new NoteComposerStore("s1", storage);
    const key = store.open(NEW_NOTE);
    store.update(key, { body: "sent", status: "sending" });
    expect(new NoteComposerStore("s1", storage).getSnapshot()).toMatchObject([
      { key, body: "sent", status: "editing" },
    ]);

    store.update(key, { awaiting: { generation: "g1", stateRevision: 3 } });
    expect(new NoteComposerStore("s1", storage).getSnapshot()).toEqual([]);
  });

  // Intent: reading `window.sessionStorage` throws when storage is blocked; the page must
  // still start, without the reload safety net.
  test("starts without storage when the browser refuses it", () => {
    const holder = globalThis as { window?: unknown };
    holder.window = {
      get sessionStorage(): Storage {
        throw new Error("SecurityError");
      },
    };
    try {
      const store = new NoteComposerStore("s1", undefined);
      const key = store.open(NEW_NOTE);
      store.update(key, { body: "kept in memory" });
      expect(store.getSnapshot()).toMatchObject([{ body: "kept in memory" }]);
    } finally {
      delete holder.window;
    }
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

  // Intent: the snapshot showing the note can arrive before the save's answer; the composer
  // still closes when the answer comes, without waiting for another snapshot.
  test("closes a sent composer whose answer arrives after the snapshot that shows it", () => {
    const store = new NoteComposerStore("s1", createTestStorage());
    const key = store.open(NEW_NOTE);
    store.update(key, { status: "sending" });
    store.settleSent({ generation: "g1", stateRevision: 5 });
    expect(store.getSnapshot()).toHaveLength(1);

    store.update(key, { awaiting: { generation: "g1", stateRevision: 5 } });

    expect(store.getSnapshot()).toHaveLength(0);
  });
});
