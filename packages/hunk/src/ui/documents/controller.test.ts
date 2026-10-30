import { describe, expect, mock, test } from "bun:test";
import { createTestDeferred } from "../../../../../test/helpers/diff-helpers";
import type {
  DocumentEntry,
  DocumentReadResult,
  DocumentSource,
} from "../../core/documents/source";
import { DocumentBrowserController } from "./controller";

/** Supply a deterministic document collection without filesystem or review dependencies. */
function createTestSource() {
  const entry = (
    key: string,
    kind: DocumentEntry["kind"] = "file",
    hidden = false,
  ): DocumentEntry => ({ key, name: key, kind, hidden });
  const root = entry("root", "directory");
  const listings: string[] = [];
  const reads: string[] = [];
  let changes: (() => void) | undefined;
  let subscriptions = 0;
  const source: DocumentSource = {
    root,
    async list(key) {
      listings.push(key);
      return {
        kind: "entries",
        entries:
          key === "root"
            ? [
                entry("folder", "directory"),
                entry("a"),
                entry("b"),
                entry("hidden", "file", true),
                { ...entry("ignored"), ignored: true },
              ]
            : [entry("child")],
      };
    },
    async read(key) {
      reads.push(key);
      return { kind: "text", text: key, identity: key };
    },
    observe(_keys, onChange) {
      changes = onChange;
      subscriptions++;
      return () => {
        subscriptions--;
      };
    },
  };
  return {
    source,
    listings,
    reads,
    changes: () => changes?.(),
    subscriptions: () => subscriptions,
  };
}

describe("document browser controller", () => {
  test("lazy expansion, visibility toggles and document selection do not introduce changesets", async () => {
    const fixture = createTestSource();
    const browser = new DocumentBrowserController(fixture.source);
    await browser.initialize();
    expect(fixture.listings).toEqual(["root"]);
    expect(fixture.reads).toEqual([]);
    expect(browser.getSnapshot().rows.map((row) => row.entry.key)).toEqual([
      "root",
      "folder",
      "a",
      "b",
    ]);
    await browser.activate("folder");
    expect(fixture.listings).toEqual(["root", "folder"]);
    expect(browser.getSnapshot().rows.some((row) => row.entry.key === "child")).toBe(true);
    await browser.select("a");
    await browser.select("folder");
    expect(browser.getSnapshot().documentKey).toBe("a");
    browser.toggleExcluded();
    expect(browser.getSnapshot().rows.some((row) => row.entry.key === "ignored")).toBe(true);
    browser.close();
    expect(fixture.subscriptions()).toBe(0);
  });

  test("stale reads and reads settling after shutdown cannot replace the active document", async () => {
    const fixture = createTestSource();
    const pending = new Map<string, (result: DocumentReadResult) => void>();
    fixture.source.read = (key) => new Promise((done) => pending.set(key, done));
    const browser = new DocumentBrowserController(fixture.source);
    await browser.initialize();
    const a = browser.select("a");
    const b = browser.select("b");
    pending.get("b")!({ kind: "text", text: "new", identity: "new" });
    await b;
    pending.get("a")!({ kind: "text", text: "old", identity: "old" });
    await a;
    expect(browser.getSnapshot().document).toMatchObject({ text: "new" });
    const before = browser.getSnapshot();
    browser.close();
    await browser.refresh();
    expect(browser.getSnapshot()).toBe(before);
  });

  test("removed expanded directories release slots and observation demand", async () => {
    const fixture = createTestSource();
    const directory = (key: string): DocumentEntry => ({
      key,
      name: key,
      kind: "directory",
      hidden: false,
    });
    let replaced = false;
    let observed: readonly string[] = [];
    fixture.source.list = async (key) => ({
      kind: "entries",
      entries:
        key !== "root"
          ? []
          : replaced
            ? [directory("new-folder")]
            : Array.from({ length: 127 }, (_, index) => directory(`folder-${index}`)),
    });
    fixture.source.observe = (keys) => {
      observed = [...keys];
      return () => {};
    };
    const browser = new DocumentBrowserController(fixture.source);

    try {
      await browser.initialize();
      for (let index = 0; index < 127; index++) await browser.activate(`folder-${index}`);
      expect(browser.getSnapshot().expanded.size).toBe(128);
      replaced = true;
      await browser.refresh();
      expect([...browser.getSnapshot().expanded]).toEqual(["root"]);
      expect(observed).toEqual(["root"]);
      await browser.activate("root");
      await browser.activate("root");
      await browser.activate("new-folder");
      expect(browser.getSnapshot().expanded.has("new-folder")).toBe(true);
      expect(browser.getSnapshot().notice).toBeNull();
    } finally {
      await browser.close();
    }
  });

  test("collapsing a parent clears expanded descendants hidden by the visibility filter", async () => {
    const fixture = createTestSource();
    fixture.source.list = async (key) => ({
      kind: "entries",
      entries:
        key === "root"
          ? [{ key: "hidden", name: ".hidden", kind: "directory", hidden: true }]
          : key === "hidden"
            ? [{ key: "child", name: "child", kind: "directory", hidden: false }]
            : [],
    });
    const browser = new DocumentBrowserController(fixture.source);

    try {
      await browser.initialize();
      browser.toggleExcluded();
      await browser.activate("hidden");
      await browser.activate("child");
      browser.toggleExcluded();
      expect(browser.getSnapshot().rows.map((row) => row.entry.key)).toEqual(["root"]);
      await browser.activate("root");
      expect(browser.getSnapshot().expanded.size).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test("shutdown rejects another editor and waits for the active edit's recovery result", async () => {
    const fixture = createTestSource();
    const result = createTestDeferred<string | null>();
    const edit = mock(() => result.promise);
    fixture.source.edit = edit;
    const browser = new DocumentBrowserController(fixture.source);
    await browser.initialize();
    await browser.select("a");
    const pending = browser.editDisplayedDocument(async () => null);

    try {
      expect(await browser.editDisplayedDocument(async () => null)).toBe(
        "An editor is already open.",
      );
      expect(edit).toHaveBeenCalledTimes(1);
      let closed = false;
      const shutdown = browser.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(await browser.editDisplayedDocument(async () => null)).toBe(
        "The document session has closed.",
      );
      result.resolve("Conflict. Editor copy retained in recovery-directory.");
      await pending;
      await shutdown;
      expect(closed).toBe(true);
      expect(browser.shutdownEditNotices).toEqual([
        "Conflict. Editor copy retained in recovery-directory.",
      ]);
    } finally {
      result.resolve(null);
      await browser.close();
    }
  });

  test("an already settled recovery notice survives quit before the next UI frame", async () => {
    const fixture = createTestSource();
    fixture.source.edit = async () => "Editor copy retained in recovery-directory.";
    const browser = new DocumentBrowserController(fixture.source);

    try {
      await browser.initialize();
      await browser.select("a");
      await browser.editDisplayedDocument(async () => null);
      await browser.close();
      expect(browser.shutdownEditNotices).toEqual(["Editor copy retained in recovery-directory."]);
    } finally {
      await browser.close();
    }
  });

  test("a conflict notice survives a successful edit and refresh through shutdown", async () => {
    const fixture = createTestSource();
    const conflict = "Document changed while editing. Editor copy retained in first-recovery.";
    let result: string | null = conflict;
    fixture.source.edit = async () => result;
    const browser = new DocumentBrowserController(fixture.source);

    try {
      await browser.initialize();
      await browser.select("a");
      expect(await browser.editDisplayedDocument(async () => null)).toBe(conflict);
      result = null;
      expect(await browser.editDisplayedDocument(async () => null)).toBeNull();
      await browser.refresh();
      expect(browser.getSnapshot().notice).toBeNull();
      await browser.close();
      expect(browser.shutdownEditNotices).toEqual([conflict]);
    } finally {
      await browser.close();
    }
  });

  test("multiple editor failures retain all unique notices without inspecting their wording", async () => {
    const fixture = createTestSource();
    const conflict = "Conflict. Editor copy retained in first-recovery.";
    const failure = "Editor exited with status 1.";
    const laterConflict = "Conflict. Editor copy retained in second-recovery.";
    let result = conflict;
    fixture.source.edit = async () => {
      if (result === failure) throw new Error(failure);
      return result;
    };
    const browser = new DocumentBrowserController(fixture.source);

    try {
      await browser.initialize();
      await browser.select("a");
      for (const notice of [conflict, failure, laterConflict, conflict, "", failure]) {
        result = notice;
        expect(await browser.editDisplayedDocument(async () => null)).toBe(notice);
      }
      expect(browser.getSnapshot().notice).toBe(failure);
      await browser.close();
      expect(browser.shutdownEditNotices).toEqual([conflict, failure, laterConflict, ""]);
    } finally {
      await browser.close();
    }
  });

  test("unchanged demand reuses observation across initialization, reads and refreshes", async () => {
    const fixture = createTestSource();
    const observe = mock(fixture.source.observe!);
    fixture.source.observe = observe;
    const browser = new DocumentBrowserController(fixture.source);

    try {
      await browser.initialize();
      await browser.refresh();
      browser.toggleExcluded();
      expect(observe.mock.calls.map(([keys]) => keys)).toEqual([["root"]]);

      await browser.select("a");
      await browser.select("a");
      await browser.select("folder");
      await browser.refresh();
      expect(observe.mock.calls.map(([keys]) => keys)).toEqual([["root"], ["root", "a"]]);

      await browser.activate("folder");
      await browser.refresh();
      expect(observe.mock.calls.map(([keys]) => keys)).toEqual([
        ["root"],
        ["root", "a"],
        ["root", "folder", "a"],
      ]);
      expect(fixture.subscriptions()).toBe(1);
      await browser.close();
      expect(fixture.subscriptions()).toBe(0);
      await browser.refresh();
      expect(observe).toHaveBeenCalledTimes(3);
    } finally {
      await browser.close();
    }
  });

  test("demand changes during a listing replace observation once without restoring stale keys", async () => {
    const fixture = createTestSource();
    const observe = mock(fixture.source.observe!);
    fixture.source.observe = observe;
    const listing = createTestDeferred<Awaited<ReturnType<DocumentSource["list"]>>>();
    const originalList = fixture.source.list;
    fixture.source.list = (key, signal) =>
      key === "folder" ? listing.promise : originalList(key, signal);
    const browser = new DocumentBrowserController(fixture.source);

    try {
      await browser.initialize();
      const expansion = browser.activate("folder");
      await browser.select("a");
      await browser.activate("folder");
      listing.resolve({ kind: "entries", entries: [] });
      await expansion;
      await browser.refresh();
      expect(observe.mock.calls.map(([keys]) => keys)).toEqual([
        ["root"],
        ["root", "folder"],
        ["root", "folder", "a"],
        ["root", "a"],
      ]);
      expect(fixture.subscriptions()).toBe(1);
      expect(browser.getSnapshot().expanded.has("folder")).toBe(false);
    } finally {
      listing.resolve({ kind: "entries", entries: [] });
      await browser.close();
    }
  });

  test("a watch installed during refresh keeps its demand and queues its notification", async () => {
    const fixture = createTestSource();
    const observe = mock(fixture.source.observe!);
    fixture.source.observe = observe;
    const browser = new DocumentBrowserController(fixture.source);
    const listing = createTestDeferred<void>();

    try {
      await browser.initialize();
      const originalList = fixture.source.list;
      let delayed = false;
      fixture.source.list = async (key, signal) => {
        if (!delayed) {
          delayed = true;
          await listing.promise;
        }
        return originalList(key, signal);
      };
      const refresh = browser.refresh();
      await browser.select("a");
      fixture.changes();
      listing.resolve();
      await refresh;

      expect(observe.mock.calls.map(([keys]) => keys)).toEqual([["root"], ["root", "a"]]);
      expect(fixture.listings).toEqual(["root", "root", "root"]);
      expect(fixture.reads).toEqual(["a", "a", "a"]);
      expect(fixture.subscriptions()).toBe(1);
    } finally {
      listing.resolve();
      await browser.close();
    }
  });

  test("watch/manual refreshes serialize, retain selection, and reread only demanded content", async () => {
    const fixture = createTestSource();
    const browser = new DocumentBrowserController(fixture.source);
    await browser.initialize();
    await browser.select("a");
    await browser.refresh();
    expect(browser.getSnapshot().selectedKey).toBe("a");
    expect(fixture.reads).toEqual(["a", "a"]);
    expect(fixture.listings).toEqual(["root", "root"]);
    fixture.changes();
    await browser.refresh();
    expect(fixture.subscriptions()).toBe(1);
    browser.close();
  });
});
