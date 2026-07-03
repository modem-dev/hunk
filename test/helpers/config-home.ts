import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create an empty XDG_CONFIG_HOME for spawned hunk processes so integration tests assert
 * against built-in defaults instead of the developer's ambient ~/.config/hunk/config.toml.
 * hunk resolves XDG_CONFIG_HOME ahead of platform defaults, so this isolates every OS.
 */
export function createTestConfigHome(prefix = "hunk-test-config-") {
  return mkdtempSync(join(tmpdir(), prefix));
}
