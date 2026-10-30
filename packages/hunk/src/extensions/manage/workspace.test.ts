import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstallRecords } from "./records";
import { npmInstallName } from "./source";
import { resolveManagedNpmModuleRoot } from "./workspace";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Create recorded storage without resolving packages or loading modules. */
function createWorkspaceTestRoot() {
  const root = mkdtempSync(join(tmpdir(), "hunk-workspace-test-"));
  roots.push(root);
  return root;
}

test("resolves the complete module workspace for deeply nested entries in recorded scoped npm packages", () => {
  const root = createWorkspaceTestRoot();
  const name = npmInstallName("@test/guide");
  writeInstallRecords(root, {
    [name]: {
      kind: "npm",
      source: "npm:@test/guide",
      packageName: "@test/guide",
      version: "1.0.0",
      installedAt: "now",
      updatedAt: "now",
    },
  });
  const moduleRoot = join(root, name, "node_modules");
  const entry = join(moduleRoot, "@test", "guide", "src", "deep", "entry.ts");
  expect(resolveManagedNpmModuleRoot(entry)).toBe(moduleRoot);
  expect(resolveManagedNpmModuleRoot(join(moduleRoot, "helper", "index.ts"))).toBeUndefined();
  expect(
    resolveManagedNpmModuleRoot(join(root, name, "node_modules-other", "entry.ts")),
  ).toBeUndefined();
  expect(resolveManagedNpmModuleRoot(join(root, "sibling", "entry.ts"))).toBeUndefined();
});

test("recognizes a recorded workspace through an aliased install directory", () => {
  const root = createWorkspaceTestRoot();
  const name = npmInstallName("@test/guide");
  writeInstallRecords(root, {
    [name]: {
      kind: "npm",
      source: "npm:@test/guide",
      packageName: "@test/guide",
      version: "1.0.0",
      installedAt: "now",
      updatedAt: "now",
    },
  });
  const actualDirectory = join(root, name);
  mkdirSync(join(actualDirectory, "node_modules"), { recursive: true });
  const alias = join(root, "alias-workspace");
  symlinkSync(actualDirectory, alias, process.platform === "win32" ? "junction" : "dir");
  const moduleRoot = join(alias, "node_modules");
  expect(resolveManagedNpmModuleRoot(join(moduleRoot, "@test", "guide", "src", "entry.ts"))).toBe(
    moduleRoot,
  );

  const unowned = join(root, "unowned", name);
  mkdirSync(join(unowned, "node_modules"), { recursive: true });
  const unrelatedAlias = join(root, "unrelated-alias");
  symlinkSync(unowned, unrelatedAlias, process.platform === "win32" ? "junction" : "dir");
  expect(
    resolveManagedNpmModuleRoot(join(unrelatedAlias, "node_modules", "@test", "guide", "entry.ts")),
  ).toBeUndefined();
});

test("does not widen scopes for ordinary Git installs or unrecorded folders", () => {
  const root = createWorkspaceTestRoot();
  writeInstallRecords(root, {
    guide: {
      kind: "git",
      source: "acme/guide",
      cloneUrl: "https://github.com/acme/guide",
      commit: "abc",
      installedAt: "now",
      updatedAt: "now",
    },
  });
  mkdirSync(join(root, "unrecorded", "node_modules"), { recursive: true });
  expect(
    resolveManagedNpmModuleRoot(join(root, "guide", "node_modules", "package", "src", "entry.ts")),
  ).toBeUndefined();
  expect(
    resolveManagedNpmModuleRoot(
      join(root, "unrecorded", "node_modules", "package", "src", "entry.ts"),
    ),
  ).toBeUndefined();
});
