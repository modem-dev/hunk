import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverExtensions } from "../discovery";
import { runExtensionManageCommand } from "./cli";
import {
  installExtension,
  listExtensions,
  removeExtension,
  updateExtension,
  type ExtensionManageContext,
} from "./install";
import { readInstallRecords, writeInstallRecords } from "./records";
import { parseExtensionInstallSource } from "./source";
import { readExtensionPackageActivations, setExtensionPackageActivation } from "./activation";

// Every test here spawns real Git processes — a fixture repo, usually a clone,
// sometimes a second one for an update. Hosted Windows runners can stall a
// single clone past Bun's five-second default, so bound the suite generously.
setDefaultTimeout(30_000);

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Run one git command in a fixture repo, failing the test on error. */
function runFixtureGit(cwd: string, args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr?.toString()}`);
  }
  return proc.stdout?.toString() ?? "";
}

/** Create one commit-able extension repository fixture and return its path. */
function createExtensionRepoFixture(name: string) {
  const repo = join(createTempDir("hunk-manage-fixture-"), name);
  mkdirSync(repo, { recursive: true });
  runFixtureGit(repo, ["init", "--quiet"]);
  runFixtureGit(repo, ["config", "user.email", "test@example.com"]);
  runFixtureGit(repo, ["config", "user.name", "Hunk Test"]);
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name, version: "1.0.0", hunk: { extensions: ["./index.ts"] } }),
  );
  writeFileSync(join(repo, "index.ts"), "export default () => {};\n");
  runFixtureGit(repo, ["add", "."]);
  runFixtureGit(repo, ["commit", "--quiet", "-m", "initial"]);
  return repo;
}

/** Change a fixture's manifest and commit it. */
function commitFixtureManifest(repo: string, update: (manifest: Record<string, unknown>) => void) {
  const manifestPath = join(repo, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  update(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  runFixtureGit(repo, ["add", "."]);
  runFixtureGit(repo, ["commit", "--quiet", "-m", "update package manifest"]);
}

/** Change a fixture's manifest package identity and commit it. */
function commitFixturePackageName(repo: string, packageName: string) {
  commitFixtureManifest(repo, (manifest) => {
    manifest.name = packageName;
  });
}

/** Create a collection repository with one manifest-owned folder per package id. */
function createCollectionRepoFixture(name: string, packageIds: readonly string[]) {
  const repo = join(createTempDir("hunk-manage-collection-"), name);
  mkdirSync(repo, { recursive: true });
  runFixtureGit(repo, ["init", "--quiet"]);
  runFixtureGit(repo, ["config", "user.email", "test@example.com"]);
  runFixtureGit(repo, ["config", "user.name", "Hunk Test"]);
  for (const [index, packageId] of packageIds.entries()) {
    const dir = join(repo, `package-${index + 1}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ hunk: { packageId, extensions: ["./index.ts"] } }),
    );
    writeFileSync(join(dir, "index.ts"), "export default () => {};\n");
  }
  runFixtureGit(repo, ["add", "."]);
  runFixtureGit(repo, ["commit", "--quiet", "-m", "initial"]);
  return repo;
}

/** Add one package to a collection fixture and commit it. */
function commitCollectionPackage(repo: string, packageId: string) {
  const dir = join(repo, `package-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ hunk: { packageId, extensions: ["./index.ts"] } }),
  );
  writeFileSync(join(dir, "index.ts"), "export default () => {};\n");
  runFixtureGit(repo, ["add", "."]);
  runFixtureGit(repo, ["commit", "--quiet", "-m", `add ${packageId}`]);
}

/** Build one manage context against a fresh managed root. */
function createTestContext(): ExtensionManageContext & { logs: string[] } {
  const logs: string[] = [];
  const configRoot = createTempDir("hunk-manage-root-");
  return {
    installedRoot: join(configRoot, "installed"),
    env: { XDG_CONFIG_HOME: configRoot },
    log: (line) => logs.push(line),
    logs,
  };
}

describe("managed extension installs", () => {
  test("installs, records, and discovers a local git repository", () => {
    const repo = createExtensionRepoFixture("word-diff");
    const context = createTestContext();

    const outcome = installExtension(context, parseExtensionInstallSource(repo));

    expect(outcome.name).toBe("word-diff");
    expect(outcome.version).toBe("1.0.0");
    expect(existsSync(join(outcome.directory, "index.ts"))).toBe(true);

    const records = readInstallRecords(context.installedRoot);
    expect(records["word-diff"]?.cloneUrl).toBe(repo);
    expect(records["word-diff"]?.commit).toBe(outcome.commit);

    // Discovery picks the install up through the global group, one level below
    // the global extensions dir.
    const globalDir = join(context.installedRoot, "..");
    const candidates = discoverExtensions({
      cwd: globalDir,
      repoRoot: undefined,
      globalExtensionsDir: globalDir,
    });
    expect(candidates).toEqual([
      {
        id: "word-diff",
        path: join(context.installedRoot, "word-diff", "index.ts"),
        origin: "global",
        package: {
          id: "word-diff",
          name: "word-diff",
          version: "1.0.0",
          root: join(context.installedRoot, "word-diff"),
        },
      },
    ]);
  });

  test("rolls back a promoted install when record persistence fails", () => {
    const repo = createExtensionRepoFixture("failed-install");
    const context = createTestContext();
    context.onTransactionStep = (step) => {
      if (step === "recorded") throw new Error("injected record failure");
    };

    expect(() => installExtension(context, parseExtensionInstallSource(repo))).toThrow(
      "injected record failure",
    );
    expect(existsSync(join(context.installedRoot, "failed-install"))).toBe(false);
    expect(readInstallRecords(context.installedRoot)).toEqual({});
  });

  test("installs a pinned tag and stays put until updated", () => {
    const repo = createExtensionRepoFixture("pinned-ext");
    runFixtureGit(repo, ["tag", "v1"]);
    const context = createTestContext();

    const outcome = installExtension(context, parseExtensionInstallSource(`${repo}@v1`));
    expect(readInstallRecords(context.installedRoot)["pinned-ext"]?.ref).toBe("v1");

    // A new commit on the default branch must not move a tag-pinned install.
    writeFileSync(join(repo, "extra.ts"), "export const later = true;\n");
    runFixtureGit(repo, ["add", "."]);
    runFixtureGit(repo, ["commit", "--quiet", "-m", "later"]);

    const update = updateExtension(context, "pinned-ext");
    expect(update.changed).toBe(false);
    expect(update.commit).toBe(outcome.commit);
  });

  test("updates a branch-tracking install to the new commit", () => {
    const repo = createExtensionRepoFixture("tracking-ext");
    const context = createTestContext();
    const installed = installExtension(context, parseExtensionInstallSource(repo));

    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "tracking-ext",
        version: "1.1.0",
        hunk: { extensions: ["./index.ts"] },
      }),
    );
    runFixtureGit(repo, ["add", "."]);
    runFixtureGit(repo, ["commit", "--quiet", "-m", "bump"]);

    const update = updateExtension(context, "tracking-ext");
    expect(update.changed).toBe(true);
    expect(update.previousCommit).toBe(installed.commit);
    expect(update.commit).not.toBe(installed.commit);
    expect(update.version).toBe("1.1.0");
    expect(readInstallRecords(context.installedRoot)["tracking-ext"]?.commit).toBe(update.commit);
  });

  test.each(["promoted", "recorded", "activated"] as const)(
    "rolls back code and metadata when update fails after %s",
    (failureStep) => {
      const repo = createExtensionRepoFixture(`rollback-${failureStep}`);
      const context = createTestContext();
      const installed = installExtension(context, parseExtensionInstallSource(repo));
      const installedEntry = join(installed.directory, "index.ts");
      const previousSource = readFileSync(installedEntry, "utf8");
      const previousRecords = readInstallRecords(context.installedRoot);
      const previousActivations = readExtensionPackageActivations(context.env);

      writeFileSync(join(repo, "index.ts"), `export default () => "${failureStep}";\n`);
      runFixtureGit(repo, ["add", "."]);
      runFixtureGit(repo, ["commit", "--quiet", "-m", `update ${failureStep}`]);
      context.onTransactionStep = (step) => {
        if (step === failureStep) throw new Error(`injected ${failureStep} failure`);
      };

      expect(() => updateExtension(context, installed.name)).toThrow(
        `injected ${failureStep} failure`,
      );
      expect(readFileSync(installedEntry, "utf8")).toBe(previousSource);
      expect(readInstallRecords(context.installedRoot)).toEqual(previousRecords);
      expect(readExtensionPackageActivations(context.env)).toEqual(previousActivations);
      expect(existsSync(join(context.installedRoot, `.previous-${installed.name}`))).toBe(false);
      expect(
        existsSync(join(context.installedRoot, `.staging-${installed.name}-${process.pid}`)),
      ).toBe(false);
    },
  );

  test("keeps an updated install disabled when its manifest package id changes", () => {
    const repo = createExtensionRepoFixture("renamed-ext");
    const context = createTestContext();
    installExtension(context, parseExtensionInstallSource(repo));
    expect(setExtensionPackageActivation("renamed-ext", false, context.env)).toBe(true);

    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "renamed-package",
        version: "2.0.0",
        hunk: { extensions: ["./index.ts"] },
      }),
    );
    runFixtureGit(repo, ["add", "."]);
    runFixtureGit(repo, ["commit", "--quiet", "-m", "rename package"]);

    const update = updateExtension(context, "renamed-ext");

    expect(update.changed).toBe(true);
    expect(update.packages.map((entry) => entry.id)).toEqual(["renamed-package"]);
    expect(readExtensionPackageActivations(context.env)).toEqual({
      "renamed-ext": false,
      "renamed-package": false,
    });
  });

  test("recovers a disabled package identity from a legacy record before renaming it", () => {
    const repo = createExtensionRepoFixture("legacy-record-rename");
    commitFixturePackageName(repo, "old-owned-package");
    const context = createTestContext();
    installExtension(context, parseExtensionInstallSource(repo));
    const records = readInstallRecords(context.installedRoot);
    const record = records["legacy-record-rename"]!;
    const { packageIds: _legacyOmission, ...legacyRecord } = record;
    writeInstallRecords(context.installedRoot, { "legacy-record-rename": legacyRecord });
    expect(setExtensionPackageActivation("old-owned-package", false, context.env)).toBe(true);

    commitFixturePackageName(repo, "new-owned-package");
    const update = updateExtension(context, "legacy-record-rename");

    expect(update.packages.map((entry) => entry.id)).toEqual(["new-owned-package"]);
    expect(readExtensionPackageActivations(context.env)).toEqual({
      "old-owned-package": false,
      "new-owned-package": false,
    });
  });

  test("rejects additions against a disabled package recovered from a legacy record", () => {
    const repo = createCollectionRepoFixture("legacy-record-addition", ["old-owned-package"]);
    const context = createTestContext();
    const installed = installExtension(context, parseExtensionInstallSource(repo));
    const records = readInstallRecords(context.installedRoot);
    const record = records["legacy-record-addition"]!;
    const { packageIds: _legacyOmission, ...legacyRecord } = record;
    writeInstallRecords(context.installedRoot, { "legacy-record-addition": legacyRecord });
    expect(setExtensionPackageActivation("old-owned-package", false, context.env)).toBe(true);
    commitCollectionPackage(repo, "added-package");

    expect(() => updateExtension(context, "legacy-record-addition")).toThrow(
      "would add or ambiguously replace package identities",
    );
    expect(readInstallRecords(context.installedRoot)["legacy-record-addition"]?.commit).toBe(
      installed.commit,
    );
    expect(readExtensionPackageActivations(context.env)).toEqual({
      "old-owned-package": false,
    });
  });

  test("allows a package addition when the install has no explicit denial", () => {
    const repo = createCollectionRepoFixture("growing-ext", ["package-a"]);
    const context = createTestContext();
    installExtension(context, parseExtensionInstallSource(repo));
    commitCollectionPackage(repo, "package-b");

    const update = updateExtension(context, "growing-ext");
    expect(update.packages.map((entry) => entry.id)).toEqual(["package-a", "package-b"]);
  });

  test("rejects a package addition while an existing package is denied", () => {
    const repo = createCollectionRepoFixture("denied-growing-ext", ["package-a"]);
    const context = createTestContext();
    const installed = installExtension(context, parseExtensionInstallSource(repo));
    expect(setExtensionPackageActivation("package-a", false, context.env)).toBe(true);
    commitCollectionPackage(repo, "package-b");

    expect(() => updateExtension(context, "denied-growing-ext")).toThrow(
      "would add or ambiguously replace package identities",
    );
    expect(readInstallRecords(context.installedRoot)["denied-growing-ext"]?.commit).toBe(
      installed.commit,
    );
    expect(readExtensionPackageActivations(context.env)).toEqual({ "package-a": false });
  });

  test("rejects duplicate package ids declared by distinct roots in one install", () => {
    const repo = createCollectionRepoFixture("duplicate-roots", ["shared", "shared"]);
    const context = createTestContext();

    expect(() => installExtension(context, parseExtensionInstallSource(repo))).toThrow(
      'package id "shared" is declared by distinct package roots',
    );
    expect(readInstallRecords(context.installedRoot)).toEqual({});
  });

  test("refuses a repository that contains no extension", () => {
    const repo = join(createTempDir("hunk-manage-empty-"), "not-an-ext");
    mkdirSync(repo, { recursive: true });
    runFixtureGit(repo, ["init", "--quiet"]);
    runFixtureGit(repo, ["config", "user.email", "test@example.com"]);
    runFixtureGit(repo, ["config", "user.name", "Hunk Test"]);
    writeFileSync(join(repo, "README.md"), "not an extension\n");
    runFixtureGit(repo, ["add", "."]);
    runFixtureGit(repo, ["commit", "--quiet", "-m", "initial"]);
    const context = createTestContext();

    expect(() => installExtension(context, parseExtensionInstallSource(repo))).toThrow(
      /does not contain a Hunk extension/,
    );
    expect(existsSync(join(context.installedRoot, "not-an-ext"))).toBe(false);
    expect(readInstallRecords(context.installedRoot)).toEqual({});
  });

  test("refuses to install over an existing record or an unmanaged directory", () => {
    const repo = createExtensionRepoFixture("twice-ext");
    const context = createTestContext();
    installExtension(context, parseExtensionInstallSource(repo));

    expect(() => installExtension(context, parseExtensionInstallSource(repo))).toThrow(
      /already installed/,
    );

    mkdirSync(join(context.installedRoot, "hand-copied"), { recursive: true });
    expect(() =>
      installExtension(context, {
        ...parseExtensionInstallSource(repo),
        name: "hand-copied",
      }),
    ).toThrow(/not a managed install/);
  });

  test("removes a managed install's directory and record", () => {
    const repo = createExtensionRepoFixture("removable-ext");
    const context = createTestContext();
    const outcome = installExtension(context, parseExtensionInstallSource(repo));

    removeExtension(context, "removable-ext");

    expect(existsSync(outcome.directory)).toBe(false);
    expect(readInstallRecords(context.installedRoot)).toEqual({});
    expect(() => removeExtension(context, "removable-ext")).toThrow(/not a managed install/);
  });

  test("lists installs with version, source, and missing-directory state", () => {
    const repo = createExtensionRepoFixture("listed-ext");
    const context = createTestContext();
    installExtension(context, parseExtensionInstallSource(repo));

    const entries = listExtensions(context);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("listed-ext");
    expect(entries[0]?.version).toBe("1.0.0");
    expect(entries[0]?.present).toBe(true);

    rmSync(join(context.installedRoot, "listed-ext"), { recursive: true, force: true });
    expect(listExtensions(context)[0]?.present).toBe(false);
  });
});

describe("hunk extension command runner", () => {
  /** Drive the runner against a temp config dir, capturing output. */
  function createRunnerIo(confirmAnswer?: boolean) {
    const configDir = createTempDir("hunk-manage-config-");
    const out: string[] = [];
    const err: string[] = [];
    return {
      configDir,
      out,
      err,
      io: {
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => err.push(text),
        ...(confirmAnswer !== undefined ? { confirm: async () => confirmAnswer } : {}),
        env: { XDG_CONFIG_HOME: configDir } as NodeJS.ProcessEnv,
      },
    };
  }

  test("install --yes runs end to end and list reports it", async () => {
    const repo = createExtensionRepoFixture("runner-ext");
    const runner = createRunnerIo();

    const exitCode = await runExtensionManageCommand(
      { kind: "extension-manage", action: "install", source: repo, yes: true },
      runner.io,
    );

    expect(exitCode).toBe(0);
    expect(runner.out.join("")).toContain("Installed runner-ext v1.0.0");

    const listExit = await runExtensionManageCommand(
      { kind: "extension-manage", action: "list" },
      runner.io,
    );
    expect(listExit).toBe(0);
    expect(runner.out.join("")).toContain("runner-ext  v1.0.0");
  });

  test("sanitizes package version metadata in install and update output", async () => {
    const repo = createExtensionRepoFixture("display-ext");
    commitFixtureManifest(repo, (manifest) => {
      manifest.version = "1.0.0\u001b[31m\nunsafe";
    });
    const runner = createRunnerIo();
    await runExtensionManageCommand(
      { kind: "extension-manage", action: "install", source: repo, yes: true },
      runner.io,
    );
    expect(runner.out.join("")).toContain("v1.0.0[31munsafe");
    expect(runner.out.join("")).not.toContain("\u001b");
    expect(runner.out.join("")).not.toContain("\nunsafe");

    commitFixtureManifest(repo, (manifest) => {
      manifest.version = "2.0.0\u001b[32m\runsafe";
    });
    await runExtensionManageCommand(
      { kind: "extension-manage", action: "update", name: "display-ext" },
      runner.io,
    );
    expect(runner.out.join("")).toContain("to v2.0.0[32munsafe");
    expect(runner.out.join("")).not.toContain("\u001b");
  });

  test("lists and toggles a stable package identity independently of installation", async () => {
    const repo = createExtensionRepoFixture("toggle-ext");
    const runner = createRunnerIo();
    await runExtensionManageCommand(
      { kind: "extension-manage", action: "install", source: repo, yes: true },
      runner.io,
    );

    expect(
      await runExtensionManageCommand(
        { kind: "extension-manage", action: "disable", name: "toggle-ext" },
        runner.io,
      ),
    ).toBe(0);
    expect(readExtensionPackageActivations(runner.io.env)).toEqual({ "toggle-ext": false });
    await runExtensionManageCommand({ kind: "extension-manage", action: "list" }, runner.io);
    expect(runner.out.join("")).toContain("toggle-ext (disabled) [toggle-ext]");

    await runExtensionManageCommand(
      { kind: "extension-manage", action: "enable", name: "toggle-ext" },
      runner.io,
    );
    expect(readExtensionPackageActivations(runner.io.env)).toEqual({ "toggle-ext": true });
  });

  test("rejects an activation selector shared by an install name and another package", async () => {
    const installNamedTarget = createExtensionRepoFixture("selector-target");
    const packageNamedTarget = createExtensionRepoFixture("other-install");
    commitFixturePackageName(installNamedTarget, "first-package");
    commitFixturePackageName(packageNamedTarget, "selector-target");
    const runner = createRunnerIo();
    for (const repo of [installNamedTarget, packageNamedTarget]) {
      await runExtensionManageCommand(
        { kind: "extension-manage", action: "install", source: repo, yes: true },
        runner.io,
      );
    }

    await expect(
      runExtensionManageCommand(
        { kind: "extension-manage", action: "disable", name: "selector-target" },
        runner.io,
      ),
    ).rejects.toThrow("matches both a managed install name and a package id");
  });

  test("rejects duplicate package ids across managed installs and updates", async () => {
    const first = createExtensionRepoFixture("duplicate-one");
    const second = createExtensionRepoFixture("duplicate-two");
    commitFixturePackageName(first, "shared-package");
    const runner = createRunnerIo();
    await runExtensionManageCommand(
      { kind: "extension-manage", action: "install", source: first, yes: true },
      runner.io,
    );

    commitFixturePackageName(second, "shared-package");
    await expect(
      runExtensionManageCommand(
        { kind: "extension-manage", action: "install", source: second, yes: true },
        runner.io,
      ),
    ).rejects.toThrow('package id "shared-package" is already owned');

    const unique = createExtensionRepoFixture("unique-two");
    await runExtensionManageCommand(
      { kind: "extension-manage", action: "install", source: unique, yes: true },
      runner.io,
    );
    commitFixturePackageName(unique, "shared-package");
    await expect(
      runExtensionManageCommand(
        { kind: "extension-manage", action: "update", name: "unique-two" },
        runner.io,
      ),
    ).rejects.toThrow('package id "shared-package" is already owned');
  });

  test("install without --yes needs a confirmation and honors a refusal", async () => {
    const repo = createExtensionRepoFixture("prompted-ext");
    const noTerminal = createRunnerIo();

    await expect(
      runExtensionManageCommand(
        { kind: "extension-manage", action: "install", source: repo, yes: false },
        noTerminal.io,
      ),
    ).rejects.toThrow(/no terminal/);

    const refused = createRunnerIo(false);
    const exitCode = await runExtensionManageCommand(
      { kind: "extension-manage", action: "install", source: repo, yes: false },
      refused.io,
    );
    expect(exitCode).toBe(1);
    expect(refused.out.join("")).toContain("full user permissions");
    expect(refused.out.join("")).toContain("Install cancelled.");
  });
});

describe("install validation strictness", () => {
  test("refuses a repository whose only entry is an incidental src/index.ts", () => {
    // The shape of nearly every JavaScript project — and of pi extensions,
    // whose manifests use a `pi` field instead of `hunk`.
    const repo = join(createTempDir("hunk-manage-incidental-"), "pi-shaped");
    mkdirSync(join(repo, "src"), { recursive: true });
    runFixtureGit(repo, ["init", "--quiet"]);
    runFixtureGit(repo, ["config", "user.email", "test@example.com"]);
    runFixtureGit(repo, ["config", "user.name", "Hunk Test"]);
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "pi-shaped", pi: { extensions: ["./src/index.ts"] } }),
    );
    writeFileSync(join(repo, "src", "index.ts"), "export default () => {};\n");
    runFixtureGit(repo, ["add", "."]);
    runFixtureGit(repo, ["commit", "--quiet", "-m", "initial"]);
    const context = createTestContext();

    expect(() => installExtension(context, parseExtensionInstallSource(repo))).toThrow(
      /does not contain a Hunk extension/,
    );
  });

  test("accepts a collection repository of subfolders with hunk manifests", () => {
    const repo = join(createTempDir("hunk-manage-collection-"), "ext-pack");
    mkdirSync(join(repo, "one"), { recursive: true });
    runFixtureGit(repo, ["init", "--quiet"]);
    runFixtureGit(repo, ["config", "user.email", "test@example.com"]);
    runFixtureGit(repo, ["config", "user.name", "Hunk Test"]);
    writeFileSync(
      join(repo, "one", "package.json"),
      JSON.stringify({ name: "one", hunk: { extensions: ["./entry.ts"] } }),
    );
    writeFileSync(join(repo, "one", "entry.ts"), "export default () => {};\n");
    runFixtureGit(repo, ["add", "."]);
    runFixtureGit(repo, ["commit", "--quiet", "-m", "initial"]);
    const context = createTestContext();

    const outcome = installExtension(context, parseExtensionInstallSource(repo));
    expect(outcome.name).toBe("ext-pack");
  });
});
