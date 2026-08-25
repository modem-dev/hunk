import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { readInstallRecords } from "./records";
import { parseExtensionInstallSource } from "./source";

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

/** Build one manage context against a fresh managed root. */
function createTestContext(): ExtensionManageContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    installedRoot: join(createTempDir("hunk-manage-root-"), "installed"),
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
      },
    ]);
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
