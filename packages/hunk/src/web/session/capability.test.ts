import { describe, expect, test } from "bun:test";
import {
  fragmentWithoutCapability,
  reviewCapabilityStorageKey,
  reviewLinkWithCapability,
  takeReviewCapability,
  watchReviewCapability,
} from "./capability";

const CAPABILITY = "A".repeat(43);

/** An in-memory `sessionStorage` stand-in. */
function createTestStorage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

/** A `history` stand-in that records the addresses it was given. */
function createTestHistory() {
  const urls: string[] = [];
  return {
    urls,
    replaceState: (_state: unknown, _title: string, url?: string | URL | null) =>
      void urls.push(String(url)),
  };
}

describe("takeReviewCapability", () => {
  test("moves the capability from the fragment into tab storage, keeping other parameters", () => {
    const storage = createTestStorage();
    const history = createTestHistory();
    const capability = takeReviewCapability({
      sessionId: "s1",
      location: {
        pathname: "/review/s1/",
        search: "",
        hash: `#capability=${CAPABILITY}&file=a%2Fb`,
      },
      storage,
      history,
    });

    expect(capability).toBe(CAPABILITY);
    expect(storage.values.get(reviewCapabilityStorageKey("s1"))).toBe(CAPABILITY);
    expect(history.urls).toEqual(["/review/s1/#file=a%2Fb"]);
  });

  test("reads the stored capability after a reload, per session", () => {
    const storage = createTestStorage({ [reviewCapabilityStorageKey("s1")]: CAPABILITY });
    const location = { pathname: "/review/s1/", hash: "" };
    expect(takeReviewCapability({ sessionId: "s1", location, storage })).toBe(CAPABILITY);
    expect(takeReviewCapability({ sessionId: "s2", location, storage })).toBeUndefined();
  });

  test("returns nothing for a malformed stored value or a tab with no storage", () => {
    const storage = createTestStorage({ [reviewCapabilityStorageKey("s1")]: "not a token" });
    const location = { pathname: "/review/s1/", hash: "" };
    expect(takeReviewCapability({ sessionId: "s1", location, storage })).toBeUndefined();
    expect(takeReviewCapability({ sessionId: "s1", location })).toBeUndefined();
  });

  test("still uses the fragment's capability when storage refuses it", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const location = { pathname: "/review/s1/", hash: `#capability=${CAPABILITY}` };
    expect(takeReviewCapability({ sessionId: "s1", location, storage })).toBe(CAPABILITY);
  });
});

describe("review links", () => {
  test("strips only the capability from a fragment", () => {
    expect(fragmentWithoutCapability(`#capability=${CAPABILITY}`)).toBe("");
    expect(fragmentWithoutCapability(`#hunk=2&capability=${CAPABILITY}`)).toBe("#hunk=2");
  });

  test("rebuilds the full link with the capability first", () => {
    expect(
      reviewLinkWithCapability(
        { origin: "http://127.0.0.1:1", pathname: "/review/s1/", hash: "#hunk=2" },
        CAPABILITY,
      ),
    ).toBe(`http://127.0.0.1:1/review/s1/#capability=${CAPABILITY}&hunk=2`);
  });
});

describe("watchReviewCapability", () => {
  /** A window stand-in whose address a test can move and whose events it can fire. */
  function createTestWindow(hash: string) {
    const listeners = new Map<string, Set<() => void>>();
    return {
      location: { pathname: "/review/s1/", search: "", hash },
      addEventListener: (type: string, listener: () => void) => {
        listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
      },
      removeEventListener: (type: string, listener: () => void) => {
        listeners.get(type)?.delete(listener);
      },
      fire: (type: string) => listeners.get(type)?.forEach((listener) => listener()),
      count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    };
  }

  test("strips a capability pasted into a tab already on the session", () => {
    const target = createTestWindow("#at=file%2Fa");
    const storage = createTestStorage();
    const history = createTestHistory();
    const stop = watchReviewCapability({ sessionId: "s1", target, storage, history });

    target.location.hash = `#capability=${CAPABILITY}&at=file%2Fb`;
    target.fire("hashchange");
    expect(storage.values.get(reviewCapabilityStorageKey("s1"))).toBe(CAPABILITY);
    expect(history.urls).toEqual(["/review/s1/#at=file%2Fb"]);

    // Forward onto an entry that still carries the key is stripped through `popstate`.
    target.fire("popstate");
    expect(history.urls).toHaveLength(2);

    stop();
    expect(target.count()).toBe(0);
  });

  test("leaves an address with no capability alone", () => {
    const target = createTestWindow("#at=file%2Fa");
    const history = createTestHistory();
    watchReviewCapability({ sessionId: "s1", target, storage: createTestStorage(), history });
    target.fire("hashchange");
    expect(history.urls).toEqual([]);
  });
});
