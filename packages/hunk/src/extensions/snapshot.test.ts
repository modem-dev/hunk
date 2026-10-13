import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isValidElement, useState } from "react";
import { discoverExtensions } from "./discovery";
import { resolveCanonicalPath } from "../core/run/paths";
import { loadExtensions } from "./host";
import { prepareRepoExtensionSnapshot, resolveRepoSnapshotEntry } from "./snapshot";
import { resolveRepoTrust, writeExtensionTrust } from "./trust";

const roots: string[] = [];

/** Isolate executable fixtures and approval storage from the user's actual configuration. */
function createTestSnapshotFixture() {
  const root = mkdtempSync(join(tmpdir(), "hunk-snapshot-"));
  roots.push(root);
  const repo = join(root, "repo");
  const env = { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home", ".config") };
  const statePath = join(env.XDG_CONFIG_HOME, "hunk", "state.json");
  const entry = join(repo, ".hunk", "extensions", "example", "index.ts");
  const marker = join(root, "executed.txt");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'approved'); export default function () {}`,
  );
  const candidates = () =>
    discoverExtensions({ cwd: repo, repoRoot: repo, globalExtensionsDir: join(root, "global") });
  const prepare = () => prepareRepoExtensionSnapshot(repo, candidates());
  const load = () => loadExtensions({ cwd: repo, repoRoot: repo, env, candidates: candidates() });
  return { root, repo, env, statePath, entry, marker, candidates, prepare, load };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("repository extension snapshots", () => {
  test("does not evaluate code until captured bytes are approved, and imports user-owned artifacts", async () => {
    const fixture = createTestSnapshotFixture();
    const pending = await fixture.load();
    expect(pending.loaded).toEqual([]);
    expect(pending.pendingTrustSnapshot).toBeDefined();
    expect(existsSync(fixture.marker)).toBeFalse();
    writeExtensionTrust(fixture.repo, "trusted", {
      env: fixture.env,
      snapshot: pending.pendingTrustSnapshot,
    });
    const approved = await fixture.load();
    expect(approved.issues).toEqual([]);
    expect(approved.loaded.map((entry) => entry.sourcePath)).toEqual([fixture.entry]);
    expect(approved.pendingTrustRepoRoot).toBeUndefined();
    expect(readFileSync(fixture.marker, "utf8")).toBe("approved");
    const snapshot = await fixture.prepare();
    const artifact = resolveRepoSnapshotEntry(snapshot, snapshot.entries[0]!.candidate, {
      env: fixture.env,
    });
    expect(resolveCanonicalPath(artifact)).toBe(
      resolveCanonicalPath(
        join(
          fixture.env.XDG_CONFIG_HOME,
          "hunk",
          "extension-snapshots",
          snapshot.fingerprint,
          `${snapshot.entries[0]!.digest}.mjs`,
        ),
      ),
    );
  });

  test("retirement during snapshot preparation prevents even an approved module from evaluating", async () => {
    const fixture = createTestSnapshotFixture();
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    let retire = () => {};
    const result = await loadExtensions({
      cwd: fixture.repo,
      repoRoot: fixture.repo,
      env: fixture.env,
      candidates: fixture.candidates(),
      onProvisionalLoad: (result) => {
        retire = () => {
          result.registry.eventBusPhase = "closed";
        };
      },
      resolveRepoTrustImpl: (root, options) => {
        if (options.fingerprint) retire();
        return resolveRepoTrust(root, options);
      },
    });
    expect(result.loaded).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  test("bounds source bytes and entry counts before evaluating or compiling untrusted input", async () => {
    const fixture = createTestSnapshotFixture();
    writeFileSync(fixture.entry, "//" + "x".repeat(8 * 1024 * 1024));
    const oversized = await fixture.load();
    expect(oversized.loaded).toEqual([]);
    expect(oversized.issues[0]?.message).toContain("limit");
    expect(existsSync(fixture.marker)).toBeFalse();
    const candidate = fixture.candidates()[0]!;
    await expect(
      prepareRepoExtensionSnapshot(
        fixture.repo,
        Array.from({ length: 65 }, (_unused, index) => ({ ...candidate, id: `entry-${index}` })),
      ),
    ).rejects.toThrow("64-entry limit");
  });

  test("rejects non-regular resolver inputs before the native module resolver reads them", async () => {
    const fixture = createTestSnapshotFixture();
    mkdirSync(join(fixture.repo, "tsconfig.json"));
    const result = await fixture.load();
    expect(result.loaded).toEqual([]);
    expect(result.issues[0]?.message).toContain("regular file");
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  test("preserves host API, React JSX runtime, and CommonJS host module identity", async () => {
    const fixture = createTestSnapshotFixture();
    const jsxEntry = fixture.entry.replace(/\.ts$/, ".tsx");
    rmSync(fixture.entry);
    writeFileSync(
      jsxEntry,
      `import {matchesKey} from 'hunkdiff/extension';
import React, {useState} from 'react'; export {useState};
function Sidebar() {return <text content={React.version} />;}
export default function(hunk) {
  if (typeof matchesKey !== 'function') throw new Error('missing host API');
  hunk.registerSidebarView({id:'snapshot-sidebar', component:Sidebar});
}`,
    );
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    const loaded = await fixture.load();
    expect(loaded.issues).toEqual([]);
    expect(loaded.registry.panes).toHaveLength(1);
    const component = loaded.registry.panes[0]!.pane.component as () => unknown;
    expect(isValidElement(component())).toBeTrue();
    const artifact = resolveRepoSnapshotEntry(snapshot, snapshot.entries[0]!.candidate, {
      env: fixture.env,
    });
    expect((await import(artifact)).useState).toBe(useState);

    const commonjs = join(dirname(jsxEntry), "host.cjs");
    writeFileSync(
      commonjs,
      `const React = require('react'); module.exports = {useState:React.useState};`,
    );
    writeFileSync(
      jsxEntry,
      `import {useState} from './host.cjs'; export {useState}; export default function(hunk) {hunk.registerFileLanguage('cjs', 'typescript');}`,
    );
    const updated = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot: updated });
    expect((await fixture.load()).issues).toEqual([]);
    const commonjsArtifact = resolveRepoSnapshotEntry(updated, updated.entries[0]!.candidate, {
      env: fixture.env,
    });
    expect((await import(commonjsArtifact)).useState).toBe(useState);
  });

  test("preserves import and require export conditions in the same captured dependency graph", async () => {
    const fixture = createTestSnapshotFixture();
    const pkg = join(fixture.repo, "node_modules", "fixture-pkg");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "fixture-pkg",
        exports: { ".": { import: "./import.mjs", require: "./require.cjs" }, "./blocked": null },
      }),
    );
    writeFileSync(join(pkg, "import.mjs"), `export const branch='import';`);
    writeFileSync(join(pkg, "require.cjs"), `module.exports={branch:'require'};`);
    writeFileSync(
      fixture.entry,
      `import {branch} from 'fixture-pkg'; const required=require('fixture-pkg'); export default function(hunk) {hunk.registerFileLanguage(branch, 'typescript'); hunk.registerFileLanguage(required.branch, 'typescript');}`,
    );
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    const loaded = await fixture.load();
    expect(loaded.issues).toEqual([]);
    expect(loaded.registry.fileLanguages.map((entry) => entry.matcher)).toEqual([
      { kind: "extension", value: "import" },
      { kind: "extension", value: "require" },
    ]);
    writeFileSync(
      join(pkg, "blocked.ts"),
      `export default function() {throw new Error('blocked');}`,
    );
    writeFileSync(
      fixture.entry,
      `import blocked from 'fixture-pkg/blocked'; export default blocked;`,
    );
    expect((await fixture.load()).loaded).toEqual([]);
  });

  test("preserves require examples in ordinary data strings", async () => {
    const fixture = createTestSnapshotFixture();
    writeFileSync(
      fixture.entry,
      `export default function(hunk) {hunk.registerFileLanguage("require('react')",'typescript');}`,
    );
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    const loaded = await fixture.load();
    expect(loaded.issues).toEqual([]);
    expect(loaded.registry.fileLanguages[0]?.matcher).toEqual({
      kind: "extension",
      value: "require('react')",
    });
  });

  test("does not interpret ordinary data strings or property keys as module resolvers", async () => {
    const fixture = createTestSnapshotFixture();
    writeFileSync(
      fixture.entry,
      `const options = {require: false}; export default function(hunk) {hunk.registerFileLanguage('module', 'typescript'); hunk.registerFileLanguage('macro:label', 'typescript');}`,
    );
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    const loaded = await fixture.load();
    expect(loaded.issues).toEqual([]);
    expect(loaded.registry.fileLanguages.map((entry) => entry.matcher)).toEqual([
      { kind: "extension", value: "module" },
      { kind: "extension", value: "macro:label" },
    ]);
  });

  test("changed and newly added entries cannot inherit the checkout's grant", async () => {
    const fixture = createTestSnapshotFixture();
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    writeFileSync(
      fixture.entry,
      `throw new Error('must not run changed PR entry'); export default function () {}`,
    );
    writeFileSync(
      join(dirname(fixture.entry), "..", "new.ts"),
      `throw new Error('must not run new PR entry'); export default function () {}`,
    );
    const pending = await fixture.load();
    expect(pending.loaded).toEqual([]);
    expect(pending.issues).toEqual([]);
    expect(pending.pendingTrustSnapshot?.fingerprint).not.toBe(snapshot.fingerprint);
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  test("bundles local helpers, detects changed dependency bytes even when output is unchanged, and preserves approved artifacts", async () => {
    const fixture = createTestSnapshotFixture();
    const helper = join(dirname(fixture.entry), "helper.ts");
    writeFileSync(helper, `export const value = 'original';`);
    writeFileSync(
      fixture.entry,
      `import {value} from './helper'; export default function (hunk) { hunk.registerFileLanguage(value, 'typescript'); }`,
    );
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    writeFileSync(helper, `// a PR changed this dependency\nexport const value = 'original';`);
    const changed = await fixture.load();
    expect(changed.loaded).toEqual([]);
    expect(changed.pendingTrustSnapshot?.fingerprint).not.toBe(snapshot.fingerprint);
    const artifact = resolveRepoSnapshotEntry(snapshot, snapshot.entries[0]!.candidate, {
      env: fixture.env,
    });
    expect(readFileSync(artifact, "utf8")).toBe(snapshot.entries[0]!.code);
    rmSync(helper);
    const imported = await import(artifact);
    expect(typeof imported.default).toBe("function");
  });

  test("captures repo config entries outside .hunk/extensions, including parent paths", async () => {
    const fixture = createTestSnapshotFixture();
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    const outside = join(fixture.root, "outside.ts");
    writeFileSync(
      outside,
      `throw new Error('must not run parent entry'); export default function () {}`,
    );
    const candidates = discoverExtensions({
      cwd: fixture.repo,
      repoRoot: fixture.repo,
      globalExtensionsDir: join(fixture.root, "global"),
      repoConfigPaths: ["../outside.ts"],
    });
    const pending = await loadExtensions({
      cwd: fixture.repo,
      repoRoot: fixture.repo,
      env: fixture.env,
      candidates,
    });
    expect(pending.loaded).toEqual([]);
    expect(pending.issues).toEqual([]);
    expect(pending.pendingTrustSnapshot?.entries.map((entry) => entry.candidate.path)).toContain(
      outside,
    );
  });

  test("captures package dependencies instead of resolving node_modules at runtime", async () => {
    const fixture = createTestSnapshotFixture();
    const pkg = join(fixture.repo, "node_modules", "snapshot-helper");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "snapshot-helper", main: "index.js" }),
    );
    writeFileSync(join(pkg, "index.js"), `module.exports = {value: 'original'};`);
    writeFileSync(
      fixture.entry,
      `import {value} from 'snapshot-helper'; export default function(hunk) { hunk.registerFileLanguage(value, 'typescript'); }`,
    );
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    const loaded = await fixture.load();
    expect(loaded.issues).toEqual([]);
    expect(loaded.registry.fileLanguages[0]?.matcher).toEqual({
      kind: "extension",
      value: "original",
    });
    writeFileSync(join(pkg, "index.js"), `throw new Error('changed package must not execute');`);
    expect((await fixture.load()).loaded).toEqual([]);
  });

  test.each([
    `const path = './helper'; await import(path);`,
    `const path = './helper'; require(path);`,
    `const loader = require; loader('./helper');`,
    `require.resolve('./helper');`,
    `import {createRequire} from 'node:module'; const loader = createRequire(import.meta.url);`,
  ])("refuses uncapturable runtime module resolution: %s", async (code) => {
    const fixture = createTestSnapshotFixture();
    writeFileSync(fixture.entry, `${code}\nexport default function () {}`);
    const result = await fixture.load();
    expect(result.loaded).toEqual([]);
    expect(result.issues.length).toBe(1);
    expect(result.pendingTrustSnapshot).toBeUndefined();
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  test.each([
    `import {value} from './macro' with {type:'macro'};`,
    `import {value} from './macro' assert {type:'macro'};`,
    `import {value} from 'macro:./macro';`,
    `import value = require('macro:./macro');`,
  ])("never executes Bun macros while preparing unapproved code: %s", async (statement) => {
    const fixture = createTestSnapshotFixture();
    writeFileSync(
      join(dirname(fixture.entry), "macro.ts"),
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(fixture.marker)}, 'macro ran'); export function value() {return 'macro';}`,
    );
    writeFileSync(
      fixture.entry,
      `${statement} const label: string = value(); export default function(hunk) {hunk.registerFileLanguage(label, 'typescript');}`,
    );
    const result = await fixture.load();
    expect(result.loaded).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.pendingTrustSnapshot).toBeUndefined();
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  test("rejects JSX macro import sources before Bun's transpiler can synthesize a macro import", async () => {
    const fixture = createTestSnapshotFixture();
    const entry = fixture.entry.replace(/\.ts$/, ".tsx");
    rmSync(fixture.entry);
    writeFileSync(
      entry,
      `/** @jsxImportSource macro:./macro-package */\nexport default function(hunk) {hunk.registerSidebarView({id:'macro', component:() => <text content='macro' />});}`,
    );
    const result = await fixture.load();
    expect(result.loaded).toEqual([]);
    expect(result.issues[0]?.message).toContain("host-owned JSX import source");
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  test("captures statically resolved alias targets without executing them", async () => {
    const fixture = createTestSnapshotFixture();
    writeFileSync(
      join(fixture.repo, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { chosen: ["chosen.ts"] } } }),
    );
    writeFileSync(
      join(fixture.repo, "chosen.ts"),
      `throw new Error('repo alias executed'); export const label = 'alias';`,
    );
    writeFileSync(
      fixture.entry,
      `import {label} from 'chosen'; export default function(hunk) {hunk.registerFileLanguage(label, 'typescript');}`,
    );
    const result = await fixture.load();
    expect(result.loaded).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.pendingTrustSnapshot).toBeDefined();
    expect(existsSync(fixture.marker)).toBeFalse();
    writeExtensionTrust(fixture.repo, "trusted", {
      env: fixture.env,
      snapshot: result.pendingTrustSnapshot,
    });
    writeFileSync(
      join(fixture.repo, "chosen.ts"),
      `throw new Error('changed alias target'); export const label = 'changed';`,
    );
    expect((await fixture.load()).loaded).toEqual([]);
  });

  test("resolves changed alias mappings from current captured configs without Bun's cache", async () => {
    const fixture = createTestSnapshotFixture();
    writeFileSync(join(fixture.repo, "a.ts"), `export const branch='a';`);
    writeFileSync(join(fixture.repo, "b.ts"), `export const branch='b';`);
    writeFileSync(
      fixture.entry,
      `import {branch} from 'chosen'; export default function(hunk) {hunk.registerFileLanguage(branch,'typescript');}`,
    );
    const config = join(fixture.repo, "tsconfig.json");
    writeFileSync(config, JSON.stringify({ compilerOptions: { paths: { chosen: ["./a.ts"] } } }));
    const first = await fixture.prepare();
    writeFileSync(config, JSON.stringify({ compilerOptions: { paths: { chosen: ["./b.ts"] } } }));
    const second = await fixture.prepare();
    expect(second.fingerprint).not.toBe(first.fingerprint);
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot: second });
    const loaded = await fixture.load();
    expect(loaded.issues).toEqual([]);
    expect(loaded.registry.fileLanguages[0]?.matcher).toEqual({ kind: "extension", value: "b" });
  });

  test("captures and bounds extended tsconfigs before native resolution", async () => {
    const fixture = createTestSnapshotFixture();
    const base = join(fixture.repo, "base.json");
    writeFileSync(join(fixture.repo, "tsconfig.json"), `{"extends":"./base.json"}`);
    writeFileSync(
      base,
      `{// inert JSONC config\n "compilerOptions":{"paths":{"chosen":["./helper.ts"]}},}`,
    );
    writeFileSync(join(fixture.repo, "helper.ts"), `export const branch='extended';`);
    writeFileSync(
      fixture.entry,
      `import {branch} from 'chosen'; export default function(hunk) {hunk.registerFileLanguage(branch,'typescript');}`,
    );
    const snapshot = await fixture.prepare();
    expect(snapshot.inputs.some((input) => input.path === resolveCanonicalPath(base))).toBeTrue();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    expect((await fixture.load()).issues).toEqual([]);
    writeFileSync(base, " ".repeat(8 * 1024 * 1024 + 1));
    await expect(fixture.prepare()).rejects.toThrow("limit");
    rmSync(base);
    mkdirSync(base);
    await expect(fixture.prepare()).rejects.toThrow("regular file");
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  test("bounds all nested package metadata consulted while resolving extended configs", async () => {
    const fixture = createTestSnapshotFixture();
    const pkg = join(fixture.repo, "node_modules", "configs");
    mkdirSync(join(pkg, "nested"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"configs"}');
    writeFileSync(join(pkg, "nested", "base.json"), "{}");
    writeFileSync(join(fixture.repo, "tsconfig.json"), '{"extends":"configs/nested/base.json"}');
    const nested = join(pkg, "nested", "package.json");
    writeFileSync(nested, " ".repeat(8 * 1024 * 1024 + 1) + "{}");
    await expect(fixture.prepare()).rejects.toThrow("limit");
    rmSync(nested);
    mkdirSync(nested);
    await expect(fixture.prepare()).rejects.toThrow("regular file");
    rmSync(nested, { recursive: true });
    writeFileSync(nested, "{}");
    const snapshot = await fixture.prepare();
    expect(snapshot.inputs.some((input) => input.path === resolveCanonicalPath(nested))).toBeTrue();
  });

  test("retains the defining directory of paths through multiple extended configs", async () => {
    const fixture = createTestSnapshotFixture();
    for (const name of ["a", "b"]) mkdirSync(join(fixture.repo, name));
    writeFileSync(
      join(fixture.repo, "a", "base.json"),
      '{"compilerOptions":{"paths":{"chosen":["./helper.ts"]}}}',
    );
    writeFileSync(join(fixture.repo, "b", "base.json"), '{"compilerOptions":{"strict":true}}');
    writeFileSync(join(fixture.repo, "a", "helper.ts"), `export const branch='a';`);
    writeFileSync(join(fixture.repo, "b", "helper.ts"), `export const branch='b';`);
    writeFileSync(
      join(fixture.repo, "tsconfig.json"),
      '{"extends":["./a/base.json","./b/base.json"]}',
    );
    writeFileSync(
      fixture.entry,
      `import {branch} from 'chosen'; export default function(hunk) {hunk.registerFileLanguage(branch,'typescript');}`,
    );
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    const loaded = await fixture.load();
    expect(loaded.issues).toEqual([]);
    expect(loaded.registry.fileLanguages[0]?.matcher).toEqual({ kind: "extension", value: "a" });
  });

  test("keeps locally bound require-like functions unchanged", async () => {
    const fixture = createTestSnapshotFixture();
    writeFileSync(
      fixture.entry,
      `function __require(name) {return name;} export default function(hunk) {hunk.registerFileLanguage(__require('react'),'typescript');}`,
    );
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    const loaded = await fixture.load();
    expect(loaded.issues).toEqual([]);
    expect(loaded.registry.fileLanguages[0]?.matcher).toEqual({
      kind: "extension",
      value: "react",
    });
  });

  test("bundles literal dynamic imports", async () => {
    const fixture = createTestSnapshotFixture();
    writeFileSync(join(dirname(fixture.entry), "helper.ts"), `export const value = 'literal';`);
    writeFileSync(
      fixture.entry,
      `const {value} = await import('./helper'); export default function(hunk) {hunk.registerFileLanguage(value, 'typescript');}`,
    );
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    const loaded = await fixture.load();
    expect(loaded.issues).toEqual([]);
    expect(loaded.registry.fileLanguages[0]?.matcher).toEqual({
      kind: "extension",
      value: "literal",
    });
  });

  test("rejects stale captured bytes if the checkout changes before approval", async () => {
    const fixture = createTestSnapshotFixture();
    const snapshot = await fixture.prepare();
    writeFileSync(
      fixture.entry,
      `throw new Error('changed while prompt open'); export default function () {}`,
    );
    expect(() =>
      writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot }),
    ).toThrow("changed since capture");
    expect(
      resolveRepoTrust(fixture.repo, { env: fixture.env, fingerprint: snapshot.fingerprint }),
    ).toBe("unknown");
    expect((await fixture.load()).loaded).toEqual([]);
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  test("resolver configuration changes invalidate approval even if the emitted bundle stays identical", async () => {
    const fixture = createTestSnapshotFixture();
    const config = join(fixture.repo, "tsconfig.json");
    writeFileSync(config, JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }));
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    writeFileSync(config, JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }));
    const changed = await fixture.load();
    expect(changed.loaded).toEqual([]);
    expect(changed.pendingTrustSnapshot?.fingerprint).not.toBe(snapshot.fingerprint);
    expect(() =>
      writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot }),
    ).toThrow("changed since capture");
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  test("legacy path grants require approval again but denials remain effective", async () => {
    const fixture = createTestSnapshotFixture();
    mkdirSync(dirname(fixture.statePath), { recursive: true });
    writeFileSync(
      fixture.statePath,
      JSON.stringify({ extensionTrust: { [fixture.repo]: "trusted" } }),
    );
    expect((await fixture.load()).pendingTrustSnapshot).toBeDefined();
    expect(existsSync(fixture.marker)).toBeFalse();
    writeExtensionTrust(fixture.repo, "denied", { env: fixture.env });
    expect((await fixture.load()).pendingTrustSnapshot).toBeUndefined();
    expect(resolveRepoTrust(fixture.repo, { env: fixture.env })).toBe("denied");
  });

  test("detects artifact tampering and never repairs it by silently overwriting bytes", async () => {
    const fixture = createTestSnapshotFixture();
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    const artifact = resolveRepoSnapshotEntry(snapshot, snapshot.entries[0]!.candidate, {
      env: fixture.env,
    });
    chmodSync(artifact, 0o600);
    writeFileSync(artifact, `throw new Error('tampered storage');`);
    const result = await fixture.load();
    expect(result.loaded).toEqual([]);
    expect(result.issues[0]?.message).toContain("integrity verification");
    expect(() =>
      writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot }),
    ).toThrow("integrity verification");
  });

  test("refuses approval storage inside the checkout", async () => {
    const fixture = createTestSnapshotFixture();
    const snapshot = await fixture.prepare();
    expect(() =>
      writeExtensionTrust(fixture.repo, "trusted", {
        statePath: join(fixture.repo, ".config", "state.json"),
        snapshot,
      }),
    ).toThrow("outside the repository");
    expect(existsSync(fixture.marker)).toBeFalse();
  });

  test("refuses symlinked snapshot storage", async () => {
    const fixture = createTestSnapshotFixture();
    const snapshot = await fixture.prepare();
    mkdirSync(dirname(fixture.statePath), { recursive: true });
    try {
      symlinkSync(fixture.repo, join(dirname(fixture.statePath), "extension-snapshots"), "dir");
    } catch {
      return;
    }
    expect(() =>
      writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot }),
    ).toThrow("symlinks");
  });

  test("detects symlink retargeting within the captured dependency graph", async () => {
    const fixture = createTestSnapshotFixture();
    const first = join(fixture.root, "first.ts");
    const second = join(fixture.root, "second.ts");
    const helper = join(dirname(fixture.entry), "helper.ts");
    writeFileSync(first, `export const value = 'first';`);
    writeFileSync(second, `throw new Error('new symlink target'); export const value = 'second';`);
    try {
      symlinkSync(first, helper);
    } catch {
      return;
    }
    writeFileSync(
      fixture.entry,
      `import {value} from './helper'; export default function(hunk) {hunk.registerFileLanguage(value, 'typescript');}`,
    );
    const snapshot = await fixture.prepare();
    writeExtensionTrust(fixture.repo, "trusted", { env: fixture.env, snapshot });
    rmSync(helper);
    symlinkSync(second, helper);
    expect((await fixture.load()).loaded).toEqual([]);
  });
});
