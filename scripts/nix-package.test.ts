import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./package-paths";

/** Read the Nix derivation as the static build contract validated without a Nix executable. */
function readNixPackageDefinition() {
  return readFileSync(join(REPO_ROOT, "nix", "package.nix"), "utf8");
}

describe("Nix compiled binary contract", () => {
  test("selects baseline x64 runtimes while leaving arm64 on the host runtime", () => {
    const definition = readNixPackageDefinition();
    expect(definition).toContain("if !stdenv.hostPlatform.isx86_64");
    expect(definition).toContain('then "bun-darwin-x64-baseline"');
    expect(definition).toContain('then "bun-linux-x64-musl-baseline"');
    expect(definition).toContain('else "bun-linux-x64-baseline"');
    expect(definition).toContain("lib.optionalString (compileTarget != null)");
  });

  test("embeds both the application and syntax-highlight worker entries", () => {
    const definition = readNixPackageDefinition();
    expect(definition).toContain('"./packages/hunk/src/main.tsx"');
    expect(definition).toContain('"./packages/hunk/src/highlightWorkerEntry.ts"');
  });
});
