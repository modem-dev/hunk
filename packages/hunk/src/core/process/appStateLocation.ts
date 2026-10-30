/**
 * Prepares persistent state for update notices and repository extension trust.
 * Copies legacy config-directory state on first use without replacing existing state;
 * path policy stays in run/paths and record parsing/writes stay in appStateFile.
 */
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveAppStatePath, resolveUserConfigDir } from "../run/paths";

/** Preserve legacy state until a complete copy can be published at the new location. */
export function prepareAppStatePath(env: NodeJS.ProcessEnv = process.env) {
  const path = resolveAppStatePath(env);
  if (!path || existsSync(path)) {
    return path;
  }

  const configDir = resolveUserConfigDir(env);
  const legacyPath = configDir ? join(configDir, "hunk", "state.json") : undefined;
  if (!legacyPath || legacyPath === path || !existsSync(legacyPath)) {
    return path;
  }

  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    const contents = readFileSync(legacyPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tempPath, contents, { mode: 0o600, flag: "wx" });
    // A hard link publishes complete bytes atomically and never replaces a concurrent writer.
    linkSync(tempPath, path);
    return path;
  } catch {
    // Keep using the legacy file if migration is unavailable; never reset remembered decisions.
    return existsSync(path) ? path : legacyPath;
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Cleanup must not prevent use of either successfully published or legacy state.
    }
  }
}
