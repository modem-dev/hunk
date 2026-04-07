import packageJson from "../../package.json" with { type: "json" };

export const UNKNOWN_CLI_VERSION = "0.0.0-unknown";

const PACKAGE_CLI_VERSION = packageJson.version;

/** Resolve the CLI version reported by `hunk --version`. */
export function resolveCliVersion(): string {
  if (typeof PACKAGE_CLI_VERSION !== "string" || PACKAGE_CLI_VERSION.length === 0) {
    return UNKNOWN_CLI_VERSION;
  }

  return PACKAGE_CLI_VERSION;
}
