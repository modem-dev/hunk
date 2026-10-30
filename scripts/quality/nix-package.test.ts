import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const definition = readFileSync(path.resolve(import.meta.dir, "../../nix/package.nix"), "utf8");

describe("Nix package-first paths", () => {
  test("reads the publishable manifest", () => {
    expect(definition).toContain("../packages/hunk/package.json");
  });

  test("builds through scripts/build/build-bin.ts instead of its own bun build command", () => {
    // Nix fetches Bun itself, but the compile command, entrypoints, and runtime policy stay in
    // the script that produces the npm and GitHub release binaries.
    expect(definition).toContain("./scripts/build/build-bin.ts --runtime-executable");
    expect(definition).not.toContain("build --compile");
    expect(definition).not.toContain("main.tsx");
  });

  test("fetches Bun's baseline runtime for the x64 systems build-bin.ts targets", () => {
    // build-bin.ts compiles x64 against the baseline runtime. The executable Nix hands it must be
    // that same flavor, or the Nix binary diverges from the published one on CPUs without AVX2.
    expect(definition).toContain("bun-linux-x64-baseline-${bunVersion}.tgz");
    expect(definition).toContain("bun-darwin-x64-baseline-${bunVersion}.tgz");
    expect(definition).not.toContain("bun-linux-x64-${bunVersion}.tgz");
    expect(definition).not.toContain("bun-darwin-x64-${bunVersion}.tgz");
    expect(definition).toContain("bun-linux-aarch64-${bunVersion}.tgz");
    expect(definition).toContain("bun-darwin-aarch64-${bunVersion}.tgz");
  });

  test("installs the binary and the two shipped skills from the build output", () => {
    expect(definition).toContain("cp -p ./dist/hunk $out/bin/hunk");
    expect(definition).toContain("cp -r ./dist/skills $out/");
  });
});
