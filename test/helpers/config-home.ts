import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const createdDirs: string[] = [];

/**
 * Create an empty XDG_CONFIG_HOME for spawned hunk processes so integration tests assert
 * against built-in defaults instead of the developer's ambient ~/.config/hunk/config.toml.
 * hunk resolves XDG_CONFIG_HOME ahead of platform defaults, so this isolates every OS.
 *
 * Callers create the dir at module scope, so pair it with
 * `afterAll(cleanupTestConfigHomes)` — Bun's test runner does not emit `process.on("exit")`,
 * so the helper cannot sweep after itself.
 */
export function createTestConfigHome(prefix = "hunk-test-config-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

/** Remove every config home this module created; safe to call from multiple test files. */
export function cleanupTestConfigHomes() {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
