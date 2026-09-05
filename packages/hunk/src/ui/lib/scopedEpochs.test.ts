import { describe, expect, test } from "bun:test";
import { bumpScopedEpoch, reconcileScopedEpochs, scopedEpoch } from "./scopedEpochs";

describe("scopedEpochs", () => {
  test("sums scope-wide and item-scoped counters so neither can mask the other", () => {
    let epochs = bumpScopedEpoch(new Map(), "ext:view");
    epochs = bumpScopedEpoch(epochs, "ext:view", "file-1");
    epochs = bumpScopedEpoch(epochs, "ext:view", "file-1");

    expect(scopedEpoch(epochs, "ext:view", "file-1")).toBe(3);
    expect(scopedEpoch(epochs, "ext:view", "file-2")).toBe(1);
    expect(scopedEpoch(epochs, "other", "file-1")).toBe(0);
  });

  test("bumping returns a fresh map identity", () => {
    const before = new Map<string, number>();
    const after = bumpScopedEpoch(before, "scope");
    expect(after).not.toBe(before);
    expect(before.size).toBe(0);
  });

  test("reconciles away orphaned scopes and items, keeping identity when unchanged", () => {
    let epochs = bumpScopedEpoch(new Map(), "kept");
    epochs = bumpScopedEpoch(epochs, "kept", "file-1");
    epochs = bumpScopedEpoch(epochs, "dropped-scope");
    epochs = bumpScopedEpoch(epochs, "kept", "dropped-file");

    const reconciled = reconcileScopedEpochs(epochs, ["file-1"], new Set(["kept"]));
    expect(scopedEpoch(reconciled, "kept", "file-1")).toBe(2);
    expect(scopedEpoch(reconciled, "dropped-scope", "file-1")).toBe(0);
    expect(scopedEpoch(reconciled, "kept", "dropped-file")).toBe(1);

    const unchanged = reconcileScopedEpochs(reconciled, ["file-1"], new Set(["kept"]));
    expect(unchanged).toBe(reconciled);
  });

  test("ignores malformed external entries instead of throwing", () => {
    const polluted = new Map<string, number>([["not-json", 7]]);
    const reconciled = reconcileScopedEpochs(polluted, [], new Set());
    expect(reconciled.size).toBe(0);
  });
});
