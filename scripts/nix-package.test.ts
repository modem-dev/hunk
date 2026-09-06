import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const definition = readFileSync(path.resolve(import.meta.dir, "../nix/package.nix"), "utf8");

describe("Nix package-first paths", () => {
  test("reads the publishable manifest and compiles the moved application entry", () => {
    expect(definition).toContain("../packages/hunk/package.json");
    expect(definition).toContain('"./packages/hunk/src/main.tsx"');
    expect(definition).not.toContain('"./src/main.tsx"');
  });

  test("installs the two shipped skills from the Hunk package", () => {
    expect(definition).toContain("cp -r ./packages/hunk/skills $out/");
  });
});
