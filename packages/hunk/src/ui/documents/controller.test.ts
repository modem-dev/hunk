import { describe, expect, test } from "bun:test";
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
