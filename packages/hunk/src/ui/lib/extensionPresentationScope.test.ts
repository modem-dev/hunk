import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import {
  createExtensionPresentationScopeStore,
  filterFilesByExtensionPresentationScope,
} from "./extensionPresentationScope";

function createStore(generation = "generation:1") {
  const files = [
    createTestDiffFile({ id: "alpha", path: "alpha.ts", before: "a\n", after: "b\n" }),
    createTestDiffFile({ id: "beta", path: "beta.ts", before: "a\n", after: "c\n" }),
  ];
  let currentGeneration: string | null = generation;
  let changes = 0;
  return {
    files,
    changes: () => changes,
    setGeneration(next: string | null) {
      currentGeneration = next;
    },
    store: createExtensionPresentationScopeStore({
      getGeneration: () => currentGeneration,
      getFiles: () => files,
      onChange: () => {
        changes += 1;
      },
    }),
  };
}

describe("extension presentation scopes", () => {
  test("composes extension scopes with one another while retaining user filtering as a separate layer", () => {
    const { store, files } = createStore();
    expect(
      store.set("guide", {
        generation: "generation:1",
        files: [{ fileId: "alpha", hunkIndexes: [0] }],
      }),
    ).toBe(true);
    expect(
      store.set("other", {
        generation: "generation:1",
        files: [{ fileId: "alpha", hunkIndexes: [0] }],
      }),
    ).toBe(true);
    const scope = store.get();
    expect(scope).toEqual({
      generation: "generation:1",
      files: [{ fileId: "alpha", hunkIndexes: [0] }],
    });
    expect(
      filterFilesByExtensionPresentationScope(
        files.filter((file) => file.id === "alpha"),
        scope,
      ),
    ).toEqual([files[0]!]);
  });

  test("reuses the aggregate snapshot until an effective mutation", () => {
    const { store } = createStore();
    expect(store.get()).toBeNull();
    expect(store.get()).toBeNull();

    const scope = { generation: "generation:1", files: [{ fileId: "alpha", hunkIndexes: [0] }] };
    expect(store.set("guide", scope)).toBe(true);
    const first = store.get();
    expect(first).not.toBeNull();
    expect(store.get()).toBe(first);
    expect(
      store.set("guide", { ...scope, files: [{ ...scope.files[0]!, hunkIndexes: [0] }] }),
    ).toBe(true);
    expect(store.get()).toBe(first);

    store.clear("guide");
    expect(store.get()).toBeNull();
    expect(store.get()).toBeNull();
  });

  test("clears only the owning extension scope", () => {
    const { store } = createStore();
    const scope = { generation: "generation:1", files: [{ fileId: "alpha", hunkIndexes: [0] }] };
    store.set("guide", scope);
    store.set("other", { ...scope, files: [{ fileId: "beta", hunkIndexes: [0] }] });
    store.clear("guide");
    expect(store.get()).toEqual({
      generation: "generation:1",
      files: [{ fileId: "beta", hunkIndexes: [0] }],
    });
  });

  test("rejects stale generations and invalid runtime targets without changing the active scope", () => {
    const { store } = createStore();
    const active = { generation: "generation:1", files: [{ fileId: "alpha", hunkIndexes: [0] }] };
    store.set("guide", active);
    expect(
      store.set("guide", {
        generation: "generation:0",
        files: [{ fileId: "beta", hunkIndexes: [0] }],
      }),
    ).toBe(false);
    expect(
      store.set("guide", {
        generation: "generation:1",
        files: [{ fileId: "missing", hunkIndexes: [0] }],
      }),
    ).toBe(false);
    expect(store.get()).toEqual(active);
  });

  test("clears scopes when the extension registry is retired", () => {
    const { store, changes } = createStore();
    store.set("guide", {
      generation: "generation:1",
      files: [{ fileId: "alpha", hunkIndexes: [0] }],
    });
    store.clearAll();
    expect(store.get()).toBeNull();
    expect(changes()).toBe(2);
  });
});
