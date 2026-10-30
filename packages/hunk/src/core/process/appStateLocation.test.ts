import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAppStatePath } from "./appStateLocation";
import { readAppStateRecord, writeAppStateRecord } from "./appStateFile";

const roots: string[] = [];

/** Create distinct legacy and XDG state locations for one migration test. */
function createTestStateLocations() {
  const root = mkdtempSync(join(tmpdir(), "hunk-state-migration-"));
  roots.push(root);
  const env = { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
  return {
    root,
    env,
    legacy: join(env.XDG_CONFIG_HOME, "hunk", "state.json"),
    target: join(env.XDG_STATE_HOME, "hunk", "state.json"),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("app state migration", () => {
  test("copies complete legacy state, keeps the original, and leaves no staging files", () => {
    const { env, legacy, target } = createTestStateLocations();
    const record = {
      extensionTrust: { repo: "denied" },
      updateNotice: { lastCheck: 123 },
      other: true,
    };
    writeAppStateRecord(legacy, record);

    expect(prepareAppStatePath(env)).toBe(target);
    expect(readAppStateRecord(target)).toEqual(record);
    expect(readFileSync(target, "utf8")).toBe(readFileSync(legacy, "utf8"));
    expect(readdirSync(join(env.XDG_STATE_HOME, "hunk"))).toEqual(["state.json"]);
    if (process.platform !== "win32") {
      expect(statSync(target).mode & 0o777).toBe(0o600);
    }
  });

  test("never replaces existing state, even when it is empty or corrupt", () => {
    for (const contents of ["", "not json", '{"new":true}']) {
      const { env, legacy, target } = createTestStateLocations();
      writeAppStateRecord(legacy, { old: true });
      writeAppStateRecord(target, {});
      writeFileSync(target, contents);

      expect(prepareAppStatePath(env)).toBe(target);
      expect(readFileSync(target, "utf8")).toBe(contents);
    }
  });

  test("does not create state for a fresh install or an unavailable home", () => {
    const { env, target } = createTestStateLocations();

    expect(prepareAppStatePath(env)).toBe(target);
    expect(existsSync(target)).toBe(false);
    expect(prepareAppStatePath({})).toBeUndefined();
  });

  test("falls back to legacy state when the destination cannot be created", () => {
    const { env, legacy, target } = createTestStateLocations();
    writeAppStateRecord(legacy, { remembered: true });
    writeFileSync(env.XDG_STATE_HOME, "blocks directory creation");

    expect(prepareAppStatePath(env)).toBe(legacy);
    expect(readAppStateRecord(legacy)).toEqual({ remembered: true });
    expect(existsSync(target)).toBe(false);
  });

  test("uses home fallbacks and ignores relative XDG state directories", () => {
    const { root } = createTestStateLocations();
    const env = { HOME: root, XDG_STATE_HOME: "relative-state" };
    const legacy = join(root, ".config", "hunk", "state.json");
    const target = join(root, ".local", "state", "hunk", "state.json");
    writeAppStateRecord(legacy, { remembered: true });

    expect(prepareAppStatePath(env)).toBe(target);
    expect(readAppStateRecord(target)).toEqual({ remembered: true });
  });

  test("preserves corrupt legacy bytes for existing quarantine handling", () => {
    const { env, legacy, target } = createTestStateLocations();
    writeAppStateRecord(legacy, {});
    writeFileSync(legacy, "broken state");

    expect(prepareAppStatePath(env)).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("broken state");
    expect(readFileSync(legacy, "utf8")).toBe("broken state");
  });
});
