import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const UNKNOWN_CLI_VERSION = "0.0.0-unknown";

/** Resolve the CLI version from the nearest shipped package manifest. */
export function resolveCliVersion() {
  const candidatePaths = [
    resolve(import.meta.dir, "..", "..", "package.json"),
    resolve(dirname(process.execPath), "..", "package.json"),
    resolve(dirname(process.execPath), "..", "..", "package.json"),
  ];

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      continue;
    }

    try {
      const parsed = JSON.parse(readFileSync(candidatePath, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      continue;
    }
  }

  return UNKNOWN_CLI_VERSION;
}
