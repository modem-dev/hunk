import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveCanonicalPath } from "../core/run/paths";
import { join, resolve } from "node:path";
import { loadExtensions } from "./host";
import { readExtensionTrust, resolveRepoTrust, writeExtensionTrust } from "./trust";
import { deriveExtensionId, type ExtensionCandidate } from "./types";

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Write one repo-local extension candidate that records the fact that it ran. */
function createRepoExtension(repoRoot: string): ExtensionCandidate {
  const path = join(repoRoot, ".hunk", "extensions", "repo-local.ts");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `export default function (hunk: { registerFileLanguage: (e: string, l: string) => void }) {
  hunk.registerFileLanguage("repo", "typescript");
}
`,
  );

  return { id: deriveExtensionId(path), path, origin: "repo" };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("extension trust", () => {
  test("round-trips trust decisions through the shared state file", () => {
    const stateDir = createTempDir("hunk-trust-state-");
    const statePath = join(stateDir, "state.json");
    const trustedRepo = createTempDir("hunk-trust-repo-trusted-");
    const deniedRepo = createTempDir("hunk-trust-repo-denied-");

    expect(readExtensionTrust({ statePath })).toEqual({});
    expect(resolveRepoTrust(trustedRepo, { statePath })).toBe("unknown");

    writeExtensionTrust(trustedRepo, "trusted", { statePath });
    writeExtensionTrust(deniedRepo, "denied", { statePath });

    expect(resolveRepoTrust(trustedRepo, { statePath })).toBe("trusted");
    expect(resolveRepoTrust(deniedRepo, { statePath })).toBe("denied");
    expect(Object.keys(readExtensionTrust({ statePath }))).toHaveLength(2);
  });

  /**
   * Create a directory reachable under two different spellings.
   *
   * Returns `undefined` where symlinks need privileges the environment lacks.
   * The pair stands in for every way one directory gets two names: a symlinked
   * ancestor, or the Windows 8.3 short path (`C:\Users\RUNNER~1\...`) that
   * `realpathSync.native` expands to its long form.
   */
  function createAliasedRepo(prefix: string) {
    // Use the product's own canonicalizer: plain realpathSync does not expand
    // Windows 8.3 short names, so `canonical` would itself be an alias on
    // Windows runners and the equality below would compare two aliases.
    const root = resolveCanonicalPath(createTempDir(prefix));
    const canonical = join(root, "repo");
    const alias = join(root, "alias");
    mkdirSync(canonical, { recursive: true });

    try {
      symlinkSync(canonical, alias, "dir");
    } catch {
      // Some Windows environments cannot create symlinks without elevated privileges.
      return undefined;
    }

    return { canonical, alias };
  }

  test("resolves a decision recorded under another spelling of the same repo root", () => {
    const stateDir = createTempDir("hunk-trust-alias-state-");
    const statePath = join(stateDir, "state.json");
    const repo = createAliasedRepo("hunk-trust-alias-repo-");
    if (!repo) {
      return;
    }

    // The live sequence: the trust prompt records the root discovery handed it,
    // then the reload canonicalizes its cwd before asking again. Both spellings
    // have to name one repository, or a freshly trusted repo never loads.
    writeExtensionTrust(repo.alias, "trusted", { statePath });

    expect(resolveRepoTrust(repo.canonical, { statePath })).toBe("trusted");
    expect(resolveRepoTrust(repo.alias, { statePath })).toBe("trusted");
    expect(Object.keys(readExtensionTrust({ statePath }))).toEqual([repo.canonical]);
  });

  test("honors decisions recorded before trust keys were canonicalized", () => {
    const stateDir = createTempDir("hunk-trust-legacy-state-");
    const statePath = join(stateDir, "state.json");
    const repo = createAliasedRepo("hunk-trust-legacy-repo-");
    if (!repo) {
      return;
    }

    writeFileSync(
      statePath,
      JSON.stringify({ extensionTrust: { [resolve(repo.alias)]: "denied" } }),
    );

    expect(resolveRepoTrust(repo.alias, { statePath })).toBe("denied");
  });

  test("preserves unrelated state keys when recording a decision", () => {
    const stateDir = createTempDir("hunk-trust-merge-");
    const statePath = join(stateDir, "state.json");
    writeFileSync(statePath, JSON.stringify({ version: 1, lastSeenCliVersion: "0.17.0" }));

    writeExtensionTrust(createTempDir("hunk-trust-merge-repo-"), "trusted", { statePath });

    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    expect(persisted.lastSeenCliVersion).toBe("0.17.0");
    expect(persisted.extensionTrust).toBeDefined();
  });

  test("ignores unreadable state and unrecognized decisions", () => {
    const stateDir = createTempDir("hunk-trust-invalid-");
    const statePath = join(stateDir, "state.json");
    writeFileSync(statePath, '{"extensionTrust": {"/repo": "maybe"}, ');

    expect(readExtensionTrust({ statePath })).toEqual({});

    writeFileSync(statePath, JSON.stringify({ extensionTrust: { "/repo": "maybe" } }));
    expect(readExtensionTrust({ statePath })).toEqual({});
  });

  test("resolves no state path when the environment has no home", () => {
    expect(readExtensionTrust({ env: {} })).toEqual({});
    expect(resolveRepoTrust("/repo", { env: {} })).toBe("unknown");
    expect(() => writeExtensionTrust("/repo", "trusted", { env: {} })).toThrow(
      "HOME/XDG_CONFIG_HOME",
    );
  });

  test("skips untrusted repo-local extensions and reports pending trust", async () => {
    const stateDir = createTempDir("hunk-trust-pending-state-");
    const statePath = join(stateDir, "state.json");
    const repo = createTempDir("hunk-trust-pending-repo-");
    const candidate = createRepoExtension(repo);

    const pending = await loadExtensions({
      candidates: [candidate],
      cwd: repo,
      repoRoot: repo,
      resolveRepoTrustImpl: (repoRoot) => resolveRepoTrust(repoRoot, { statePath }),
    });

    expect(pending.loaded).toEqual([]);
    expect(pending.issues).toEqual([]);
    expect(pending.registry.fileLanguages).toEqual([]);
    expect(pending.pendingTrustRepoRoot).toBe(repo);
  });

  test("loads repo-local extensions once the repo is trusted", async () => {
    const stateDir = createTempDir("hunk-trust-loaded-state-");
    const statePath = join(stateDir, "state.json");
    const repo = createTempDir("hunk-trust-loaded-repo-");
    const candidate = createRepoExtension(repo);
    writeExtensionTrust(repo, "trusted", { statePath });

    const result = await loadExtensions({
      candidates: [candidate],
      cwd: repo,
      repoRoot: repo,
      resolveRepoTrustImpl: (repoRoot) => resolveRepoTrust(repoRoot, { statePath }),
    });

    expect(result.loaded.map((entry) => entry.id)).toEqual(["repo-local"]);
    expect(result.registry.fileLanguages).toEqual([
      {
        extensionId: "repo-local",
        matcher: { kind: "extension", value: "repo" },
        language: "typescript",
      },
    ]);
    expect(result.pendingTrustRepoRoot).toBeUndefined();
  });

  test("skips denied repo-local extensions without asking again", async () => {
    const stateDir = createTempDir("hunk-trust-denied-state-");
    const statePath = join(stateDir, "state.json");
    const repo = createTempDir("hunk-trust-denied-repo-");
    const candidate = createRepoExtension(repo);
    writeExtensionTrust(repo, "denied", { statePath });

    const result = await loadExtensions({
      candidates: [candidate],
      cwd: repo,
      repoRoot: repo,
      resolveRepoTrustImpl: (repoRoot) => resolveRepoTrust(repoRoot, { statePath }),
    });

    expect(result.loaded).toEqual([]);
    expect(result.pendingTrustRepoRoot).toBeUndefined();
  });
});
