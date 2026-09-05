import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTestDirectory } from "../../../../../test/helpers/filesystem";
import {
  type ExtensionPackageActivationMap,
  planExtensionPackageActivationMigration,
  readDisabledExtensionPackageIds,
  readExtensionPackageActivations,
  setExtensionPackageActivation,
} from "./activation";

const roots: string[] = [];

/** Create an isolated user configuration environment. */
function testEnv() {
  const root = mkdtempSync(join(tmpdir(), "hunk-extension-activation-"));
  roots.push(root);
  return { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTestDirectory(root)));
});

describe("extension package activation preferences", () => {
  test("preserves exact state and carries one denial through an unambiguous rename", () => {
    const current = { a: false, b: true };
    expect(planExtensionPackageActivationMigration(["a", "b"], ["a", "b"], current)).toEqual({
      activations: current,
      changed: false,
    });
    expect(planExtensionPackageActivationMigration(["a"], ["renamed"], current)).toEqual({
      activations: { ...current, renamed: false },
      changed: true,
    });
  });

  test("allows topology changes when no previous package is explicitly denied", () => {
    const cases: ExtensionPackageActivationMap[] = [{}, { a: true, b: true }];
    for (const current of cases) {
      expect(planExtensionPackageActivationMigration(["a"], ["next-a", "next-b"], current)).toEqual(
        { activations: current, changed: false },
      );
      expect(planExtensionPackageActivationMigration(["a", "b"], ["next"], current)).toEqual({
        activations: current,
        changed: false,
      });
      expect(
        planExtensionPackageActivationMigration(["a", "b"], ["next-a", "next-b"], current),
      ).toEqual({ activations: current, changed: false });
      expect(planExtensionPackageActivationMigration(["b"], ["b", "next"], current)).toEqual({
        activations: current,
        changed: false,
      });
    }
  });

  test("rejects additions and ambiguous topology while a previous package is denied", () => {
    const current = { a: false, b: true };
    expect(
      planExtensionPackageActivationMigration(["a"], ["next-a", "next-b"], current),
    ).toBeUndefined();
    expect(planExtensionPackageActivationMigration(["a", "b"], ["next"], current)).toBeUndefined();
    expect(
      planExtensionPackageActivationMigration(["a", "b"], ["next-a", "next-b"], current),
    ).toBeUndefined();
    expect(
      planExtensionPackageActivationMigration(["a", "b"], ["a", "b", "next"], current),
    ).toBeUndefined();
    expect(planExtensionPackageActivationMigration(["a", "b"], ["a"], current)).toEqual({
      activations: current,
      changed: false,
    });
  });

  test("stores activation separately and defaults unknown packages to enabled", () => {
    const env = testEnv();
    expect(readExtensionPackageActivations(env)).toEqual({});

    expect(setExtensionPackageActivation("@acme/review-tools", false, env)).toBe(true);
    expect(readExtensionPackageActivations(env)).toEqual({ "@acme/review-tools": false });
    expect(readDisabledExtensionPackageIds(env)).toEqual(new Set(["@acme/review-tools"]));

    setExtensionPackageActivation("@acme/review-tools", true, env);
    expect(readDisabledExtensionPackageIds(env)).toEqual(new Set());
  });
});
