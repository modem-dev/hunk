import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createNpmRegistryTest } from "../../../../../test/helpers/npmRegistryTest";
import { discoverExtensions } from "../discovery";
import { runExtensionManageCommand } from "./cli";
import { installExtension, listExtensions, removeExtension, updateExtension } from "./install";
import { readInstallRecords } from "./records";
import { parseExtensionInstallSource } from "./source";

setDefaultTimeout(60_000);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

/** Isolate real package installation, registry traffic, and filesystem cleanup for each test. */
async function createNpmInstallTest(options: { authToken?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hunk-npm-test-"));
  const registry = await createNpmRegistryTest(root, options);
  cleanup.push(async () => {
    await registry.close();
    rmSync(root, { recursive: true, force: true });
  });
  const context = {
    installedRoot: join(root, "extensions", "installed"),
    env: registry.env,
    log: () => {},
  };
  return { root, registry, context };
}

test("installs scoped npm entries, dependencies and host peers without running lifecycle scripts", async () => {
  const { registry, context } = await createNpmInstallTest();
  registry.publish("hunk-test-dependency", "1.0.0", {
    manifest: { hunk: undefined, main: "index.js" },
    files: { "index.js": "module.exports = 42;" },
  });
  registry.publish("@hunk-test/guide", "1.0.0", {
    manifest: {
      hunk: { extensions: ["./entry.js"], apiVersion: 3 },
      dependencies: { "hunk-test-dependency": "1.0.0" },
      peerDependencies: { hunkdiff: "999.0.0" },
      scripts: { postinstall: "node -e \"require('fs').writeFileSync('SCRIPT-RAN', 'yes')\"" },
    },
    files: { "entry.js": "module.exports = require('hunk-test-dependency');" },
  });
  const source = parseExtensionInstallSource("npm:@hunk-test/guide@1.0.0");
  const installed = installExtension(context, source);
  expect(installed.commit).toBeUndefined();
  expect(installed.version).toBe("1.0.0");
  const packageDir = join(installed.directory, "node_modules", "@hunk-test", "guide");
  expect(existsSync(join(packageDir, "SCRIPT-RAN"))).toBe(false);
  expect(existsSync(join(installed.directory, "node_modules", "hunkdiff"))).toBe(false);
  expect(require(join(packageDir, "entry.js"))).toBe(42);
  expect(readInstallRecords(context.installedRoot)[source.name]).toMatchObject({
    kind: "npm",
    source: source.spec,
    packageName: "@hunk-test/guide",
    selector: "1.0.0",
    version: "1.0.0",
  });
  expect(
    discoverExtensions({
      cwd: context.installedRoot,
      globalExtensionsDir: join(context.installedRoot, ".."),
    }),
  ).toEqual([
    {
      id: source.name,
      path: join(packageDir, "entry.js"),
      origin: "global",
      requiresApiVersion: 3,
    },
  ]);
  expect(listExtensions(context)[0]).toMatchObject({
    name: source.name,
    version: "1.0.0",
    present: true,
  });
  removeExtension(context, source.name);
  expect(existsSync(installed.directory)).toBe(false);
  expect(readInstallRecords(context.installedRoot)).toEqual({});
});

test("forwards project registry credentials without losing user config or persisting secrets", async () => {
  const projectToken = "hunk-test-project-token";
  const userToken = "hunk-test-user-token";
  const { registry, context, root } = await createNpmInstallTest({ authToken: projectToken });
  const userRoot = join(root, "user-registry");
  mkdirSync(userRoot);
  const userRegistry = await createNpmRegistryTest(userRoot, { authToken: userToken });
  cleanup.push(() => userRegistry.close());
  userRegistry.publish("@hunk-user/helper", "1.0.0", {
    manifest: { hunk: undefined, main: "index.js" },
    files: { "index.js": "module.exports = 42;" },
  });
  const project = join(root, "project");
  const workspace = join(project, "packages", "consumer");
  const cwd = join(workspace, "nested");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ private: true, workspaces: ["packages/*"] }),
  );
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "hunk-test-workspace" }));
  // npm ignores workspace-local .npmrc files and uses the root project's configuration.
  writeFileSync(join(workspace, ".npmrc"), "@hunk-private:registry=http://127.0.0.1:9\n");
  const projectConfig = `@hunk-private:registry=${registry.registry}
//${new URL(registry.registry).host}/:_authToken=\${HUNK_TEST_PROJECT_TOKEN}
global=true
location=global
ignore-scripts=false
legacy-peer-deps=false
script-shell=node
`;
  writeFileSync(join(project, ".npmrc"), projectConfig);
  writeFileSync(
    context.env.npm_config_userconfig,
    `@hunk-user:registry=${userRegistry.registry}
//${new URL(userRegistry.registry).host}/:_authToken=\${HUNK_TEST_USER_TOKEN}
`,
  );
  const privateContext = {
    ...context,
    cwd,
    env: {
      ...context.env,
      // Only project/user scoped configuration can reach the two authenticated registries.
      npm_config_registry: "http://127.0.0.1:9",
      HUNK_TEST_PROJECT_TOKEN: projectToken,
      HUNK_TEST_USER_TOKEN: userToken,
    },
  };
  const manifest = {
    dependencies: { "@hunk-user/helper": "1.0.0" },
    peerDependencies: { hunkdiff: "999.0.0" },
    scripts: { postinstall: "node -e \"require('fs').writeFileSync('SCRIPT-RAN', 'yes')\"" },
  };
  const files = { "entry.js": "module.exports = require('@hunk-user/helper');" };
  registry.publish("@hunk-private/guide", "1.0.0", { manifest, files });
  const source = parseExtensionInstallSource("npm:@hunk-private/guide");
  const installed = installExtension(privateContext, source);
  expect(installed.version).toBe("1.0.0");
  const packageDir = join(installed.directory, "node_modules", "@hunk-private", "guide");
  expect(require(join(packageDir, "entry.js"))).toBe(42);
  expect(existsSync(join(packageDir, "SCRIPT-RAN"))).toBe(false);
  expect(existsSync(join(installed.directory, "node_modules", "hunkdiff"))).toBe(false);
  expect(existsSync(join(installed.directory, ".npmrc"))).toBe(false);
  expect(readFileSync(join(project, ".npmrc"), "utf8")).toBe(projectConfig);

  registry.publish("@hunk-private/guide", "1.1.0", { manifest, files });
  expect(updateExtension(privateContext, source.name)).toMatchObject({
    changed: true,
    version: "1.1.0",
  });
  expect(existsSync(join(installed.directory, ".npmrc"))).toBe(false);
  const records = readFileSync(join(context.installedRoot, "records.json"), "utf8");
  expect(records).not.toContain(projectToken);
  expect(records).not.toContain(userToken);

  expect(() =>
    updateExtension(
      {
        ...privateContext,
        env: { ...privateContext.env, HUNK_TEST_PROJECT_TOKEN: "wrong-token" },
      },
      source.name,
    ),
  ).toThrow(/npm install failed/);
  expect(readFileSync(join(context.installedRoot, "records.json"), "utf8")).toBe(records);
  expect(readdirSync(context.installedRoot).filter((name) => name.startsWith("."))).toEqual([]);
  expect(existsSync(join(installed.directory, ".npmrc"))).toBe(false);
});

test("suppresses lifecycle scripts in transitive Git dependencies, including inherited npm config", async () => {
  const { registry, context, root } = await createNpmInstallTest();
  const gitDir = join(root, "git-helper");
  mkdirSync(gitDir);
  const script = `node -e "require('fs').appendFileSync(process.env.HUNK_TEST_PREPARE_MARKER, 'ran')"`;
  writeFileSync(
    join(gitDir, "package.json"),
    JSON.stringify({
      name: "hunk-test-git-helper",
      version: "1.0.0",
      scripts: {
        preinstall: script,
        install: script,
        postinstall: script,
        prepare: script,
        prepack: script,
      },
    }),
  );
  writeFileSync(join(gitDir, "index.js"), "module.exports = 42;");
  writeFileSync(join(gitDir, ".npmrc"), "ignore-scripts=false\n");
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
    ["add", "."],
    ["commit", "--quiet", "-m", "initial"],
  ]) {
    const proc = Bun.spawnSync(["git", ...args], { cwd: gitDir, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(proc.stderr?.toString());
  }

  const scriptedCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: gitDir,
    stdout: "pipe",
  })
    .stdout!.toString()
    .trim();
  registry.publish("hunk-test-middle", "1.0.0", {
    manifest: {
      hunk: undefined,
      dependencies: {
        "hunk-test-git-helper": `git+${pathToFileURL(gitDir).href}#${scriptedCommit}`,
      },
    },
  });
  registry.publish("hunk-test-git-consumer", "1.0.0", {
    manifest: { dependencies: { "hunk-test-middle": "1.0.0" } },
  });
  /** Accept npm versions that honor suppression, but require a clear policy error if they try a hook. */
  function attemptScriptSuppressedTest<T>(operation: () => T): T | undefined {
    try {
      return operation();
    } catch (error) {
      expect(String(error)).toMatch(/lifecycle script; installation was blocked/);
      return undefined;
    }
  }

  for (const conflictingConfig of [false, true]) {
    const marker = join(root, `prepare-${conflictingConfig}`);
    const blockedContext = {
      ...context,
      installedRoot: join(root, `scripts-${conflictingConfig}`, "installed"),
      env: {
        ...context.env,
        npm_config_cache: join(root, `cache-${conflictingConfig}`),
        HUNK_TEST_PREPARE_MARKER: marker,
        ...(conflictingConfig
          ? {
              npm_config_ignore_scripts: "false",
              NPM_CONFIG_IGNORE_SCRIPTS: "false",
              npm_config_script_shell: "node",
              NPM_CONFIG_SCRIPT_SHELL: "node",
              "npm_config_ignore-scripts": "false",
              "NPM_CONFIG_SCRIPT-SHELL":
                process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
              "npm_config_legacy-peer-deps": "false",
            }
          : {}),
      },
    };
    const installed = attemptScriptSuppressedTest(() =>
      installExtension(blockedContext, parseExtensionInstallSource("npm:hunk-test-git-consumer")),
    );
    expect(existsSync(marker)).toBe(false);
    if (installed) {
      expect(installed.version).toBe("1.0.0");
      expect(
        require(join(installed.directory, "node_modules", "hunk-test-git-helper", "index.js")),
      ).toBe(42);
    } else {
      expect(readInstallRecords(blockedContext.installedRoot)).toEqual({});
      expect(readdirSync(blockedContext.installedRoot)).toEqual([]);
    }
  }

  // Script-free Git dependencies remain installable; a later scripted release must not
  // execute its hook or replace the working workspace/record during update.
  writeFileSync(
    join(gitDir, "package.json"),
    JSON.stringify({ name: "hunk-test-git-helper", version: "1.1.0" }),
  );
  for (const args of [
    ["add", "."],
    ["commit", "--quiet", "-m", "remove scripts"],
  ]) {
    const proc = Bun.spawnSync(["git", ...args], { cwd: gitDir, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(proc.stderr?.toString());
  }
  const safeCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: gitDir, stdout: "pipe" })
    .stdout!.toString()
    .trim();
  registry.publish("hunk-test-middle", "1.1.0", {
    manifest: {
      hunk: undefined,
      dependencies: { "hunk-test-git-helper": `git+${pathToFileURL(gitDir).href}#${safeCommit}` },
    },
  });
  registry.publish("hunk-test-git-consumer", "1.1.0", {
    manifest: { dependencies: { "hunk-test-middle": "1.1.0" } },
  });
  const marker = join(root, "prepare-update");
  const safeContext = { ...context, env: { ...context.env, HUNK_TEST_PREPARE_MARKER: marker } };
  const source = parseExtensionInstallSource("npm:hunk-test-git-consumer");
  const installed = installExtension(safeContext, source);
  expect(
    require(join(installed.directory, "node_modules", "hunk-test-git-helper", "index.js")),
  ).toBe(42);
  const before = readFileSync(join(context.installedRoot, "records.json"), "utf8");
  registry.publish("hunk-test-git-consumer", "1.2.0", {
    manifest: { dependencies: { "hunk-test-middle": "1.0.0" } },
  });
  const updated = attemptScriptSuppressedTest(() => updateExtension(safeContext, source.name));
  expect(existsSync(marker)).toBe(false);
  if (updated) {
    expect(updated.version).toBe("1.2.0");
  } else {
    expect(readFileSync(join(context.installedRoot, "records.json"), "utf8")).toBe(before);
    expect(readFileSync(join(installed.directory, "package.json"), "utf8")).toContain("1.1.0");
  }
});

test("forces local managed layout despite global npm environment or configuration", async () => {
  const { registry, context, root } = await createNpmInstallTest();
  registry.publish("hunk-test-global-config", "1.0.0");
  writeFileSync(context.env.npm_config_userconfig, "global=true\nlocation=global\n");
  for (const [index, config] of [
    {},
    { npm_config_global: "true", npm_config_location: "global" },
    { NPM_CONFIG_GLOBAL: "true", NPM_CONFIG_LOCATION: "global" },
  ].entries()) {
    // Configuration names differ only by case; fixture paths must also work on Windows.
    const name = `config-${index}`;
    const installed = installExtension(
      {
        ...context,
        installedRoot: join(root, name, "installed"),
        env: { ...context.env, ...config },
      },
      parseExtensionInstallSource("npm:hunk-test-global-config"),
    );
    expect(
      existsSync(join(installed.directory, "node_modules", "hunk-test-global-config", "entry.js")),
    ).toBe(true);
    expect(existsSync(join(installed.directory, "lib"))).toBe(false);
    expect(installed.version).toBe("1.0.0");
  }
});

test("installs and updates npm-compatible underscore and punctuation tags", async () => {
  const { registry, context } = await createNpmInstallTest();
  for (const [index, tag] of [
    "beta_test",
    "canary!",
    "release(candidate)",
    "preview'build",
  ].entries()) {
    const packageName = `hunk-test-tag-${index}`;
    registry.publish(packageName, "1.0.0", { tag });
    const source = parseExtensionInstallSource(`npm:${packageName}@${tag}`);
    expect(installExtension(context, source).version).toBe("1.0.0");
    registry.publish(packageName, "1.1.0", { tag });
    expect(updateExtension(context, source.name)).toMatchObject({
      changed: true,
      version: "1.1.0",
    });
  }
});

test("updates ranges and tags while exact versions stay pinned and repairs missing installs", async () => {
  const { registry, context } = await createNpmInstallTest();
  for (const name of ["hunk-test-range", "hunk-test-tag", "hunk-test-pin"])
    registry.publish(name, "1.0.0", { tag: "next" });
  const range = parseExtensionInstallSource("npm:hunk-test-range@^1.0.0");
  const tag = parseExtensionInstallSource("npm:hunk-test-tag@next");
  const pin = parseExtensionInstallSource("npm:hunk-test-pin@1.0.0");
  for (const source of [range, tag, pin]) installExtension(context, source);
  for (const name of ["hunk-test-range", "hunk-test-tag", "hunk-test-pin"])
    registry.publish(name, "1.1.0", { tag: "next" });
  expect(updateExtension(context, range.name)).toMatchObject({
    changed: true,
    previousRevision: "1.0.0",
    version: "1.1.0",
  });
  expect(updateExtension(context, tag.name)).toMatchObject({ changed: true, version: "1.1.0" });
  expect(updateExtension(context, pin.name)).toMatchObject({ changed: false, version: "1.0.0" });
  expect(updateExtension(context, range.name).changed).toBe(false);
  rmSync(join(context.installedRoot, pin.name), { recursive: true });
  expect(listExtensions(context).find((entry) => entry.name === pin.name)?.present).toBe(false);
  expect(updateExtension(context, pin.name)).toMatchObject({ changed: true, version: "1.0.0" });
});

test("keeps manifest entry order and distinct identities without discovering dependency code", async () => {
  const { registry, context } = await createNpmInstallTest();
  registry.publish("hunk-test-multi", "1.0.0", {
    manifest: { hunk: { extensions: ["./two/index.js", "./one/index.js"] } },
    files: {
      "two/index.js": "export default () => {};",
      "one/index.js": "export default () => {};",
    },
  });
  const source = parseExtensionInstallSource("npm:hunk-test-multi");
  installExtension(context, source);
  const entries = discoverExtensions({
    cwd: context.installedRoot,
    globalExtensionsDir: join(context.installedRoot, ".."),
  });
  expect(entries.map((entry) => entry.id)).toEqual(["two", "one"]);
  expect(entries[0]?.path).toContain(join("two", "index.js"));
});

test("failed updates preserve installed files and records and clean staging", async () => {
  const { registry, context } = await createNpmInstallTest();
  registry.publish("hunk-test-rollback", "1.0.0");
  const source = parseExtensionInstallSource("npm:hunk-test-rollback");
  const installed = installExtension(context, source);
  const before = readFileSync(join(context.installedRoot, "records.json"), "utf8");
  registry.publish("hunk-test-rollback", "1.1.0", {
    manifest: { hunk: { extensions: ["./missing.js"] } },
  });
  expect(() => updateExtension(context, source.name)).toThrow(/missing extension entry/);
  expect(readFileSync(join(context.installedRoot, "records.json"), "utf8")).toBe(before);
  expect(readFileSync(join(installed.directory, "package.json"), "utf8")).toContain("1.0.0");
  expect(readdirSync(context.installedRoot).some((name) => name.startsWith(".staging-"))).toBe(
    false,
  );
  await registry.close();
  // npm can deliberately fall back to cached metadata when the registry is offline.
  rmSync(context.env.npm_config_cache, { recursive: true, force: true });
  expect(() => updateExtension(context, source.name)).toThrow(/npm install failed/);
  expect(readFileSync(join(context.installedRoot, "records.json"), "utf8")).toBe(before);
});

test("rejects non-extension packages, escaping entries, and unavailable versions without recording installs", async () => {
  const { registry, context } = await createNpmInstallTest();
  registry.publish("hunk-test-library", "1.0.0", { manifest: { hunk: undefined } });
  registry.publish("hunk-test-escape", "1.0.0", {
    manifest: { hunk: { extensions: ["../../package.json"] } },
  });
  for (const spec of [
    "npm:hunk-test-library",
    "npm:hunk-test-escape",
    "npm:hunk-test-library@99.0.0",
  ]) {
    expect(() => installExtension(context, parseExtensionInstallSource(spec))).toThrow();
    expect(readInstallRecords(context.installedRoot)).toEqual({});
    expect(readdirSync(context.installedRoot)).toEqual([]);
  }
});

test("missing npm fails clearly and cleans staging without creating a record", async () => {
  const { context, root } = await createNpmInstallTest();
  expect(() =>
    installExtension(
      { ...context, env: { ...context.env, PATH: root, Path: root } },
      parseExtensionInstallSource("npm:hunk-test-missing"),
    ),
  ).toThrow(/npm was not found on PATH/);
  expect(readInstallRecords(context.installedRoot)).toEqual({});
  expect(readdirSync(context.installedRoot)).toEqual([]);
});

test("mixed Git/npm updates preserve legacy records and keep colliding display names separate", async () => {
  const { context, registry, root } = await createNpmInstallTest();
  const repo = join(root, "same-name");
  mkdirSync(repo);
  writeFileSync(join(repo, "index.js"), "export default () => {};");
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
    ["add", "."],
    ["commit", "--quiet", "-m", "initial"],
  ]) {
    const proc = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(proc.stderr?.toString());
  }

  installExtension(context, parseExtensionInstallSource(repo));
  // Simulate a record written by a previous Hunk version, not just a new Git record.
  const records = JSON.parse(readFileSync(join(context.installedRoot, "records.json"), "utf8"));
  delete records.installs["same-name"].kind;
  writeFileSync(join(context.installedRoot, "records.json"), JSON.stringify(records));
  registry.publish("same-name", "1.0.0");
  registry.publish("@hunk-test/same-name", "1.0.0");
  installExtension(context, parseExtensionInstallSource("npm:same-name"));
  installExtension(context, parseExtensionInstallSource("npm:@hunk-test/same-name"));
  registry.publish("same-name", "1.1.0");
  const out: string[] = [];
  const io = {
    env: { ...context.env, XDG_CONFIG_HOME: join(root, "config") },
    stdout: (text: string) => out.push(text),
    stderr: () => {},
  };
  // Point command storage at the same managed root used above.
  const configInstalled = join(root, "config", "hunk", "extensions", "installed");
  mkdirSync(join(configInstalled, ".."), { recursive: true });
  renameSync(context.installedRoot, configInstalled);
  context.installedRoot = configInstalled;
  await runExtensionManageCommand({ kind: "extension-manage", action: "update" }, io);
  expect(out.join("")).toContain("Updated same-name to v1.1.0");
  expect(out.join("")).toContain("same-name is already up to date");
  expect(listExtensions(context)).toHaveLength(3);
  removeExtension(context, "npm:same-name");
  expect(listExtensions(context)).toHaveLength(2);
  expect(updateExtension(context, "same-name").commit).toBeDefined();
  removeExtension(context, "@hunk-test/same-name");
  expect(listExtensions(context)).toHaveLength(1);
});

test("npm uses the existing command confirmation, output, update and removal flow", async () => {
  const { root, registry } = await createNpmInstallTest();
  registry.publish("hunk-test-command", "1.0.0");
  const out: string[] = [];
  const io = {
    env: { ...registry.env, XDG_CONFIG_HOME: root },
    stdout: (text: string) => out.push(text),
    stderr: () => {},
    confirm: async () => false,
  };
  const install = {
    kind: "extension-manage" as const,
    action: "install" as const,
    source: "npm:hunk-test-command",
    yes: false,
  };
  expect(await runExtensionManageCommand(install, io)).toBe(1);
  expect(out.join("")).toContain("lifecycle scripts will not run");
  expect(await runExtensionManageCommand({ ...install, yes: true }, io)).toBe(0);
  await runExtensionManageCommand({ kind: "extension-manage", action: "list" }, io);
  await runExtensionManageCommand({ kind: "extension-manage", action: "update" }, io);
  expect(out.join("")).toContain("v1.0.0  npm:hunk-test-command");
  expect(out.join("")).toContain("already up to date (v1.0.0)");
  await runExtensionManageCommand(
    { kind: "extension-manage", action: "update", name: "npm:hunk-test-command" },
    io,
  );
  await runExtensionManageCommand(
    { kind: "extension-manage", action: "remove", name: "npm:hunk-test-command" },
    io,
  );
  expect(out.join("")).toContain("Removed npm:hunk-test-command");
});
