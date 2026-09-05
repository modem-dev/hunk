import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stageSourceNpmPackage } from "./stage-source-npm-package";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Write one minimal package tree accepted by the source npm stager. */
function createTestPackage() {
  const root = mkdtempSync(path.join(tmpdir(), "hunk-source-pack-"));
  tempRoots.push(root);
  for (const directory of ["bin", "dist/npm", "skills"]) {
    mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, directory, "fixture"), directory);
  }
  for (const file of ["README.md", "LICENSE"]) writeFileSync(path.join(root, file), file);
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "hunkdiff",
      version: "1.0.0",
      scripts: { prepack: "build" },
      devDependencies: {
        "@hunk/git": "workspace:*",
        "@hunk/session-broker": "workspace:*",
        "@hunk/session-broker-bun": "workspace:*",
        "@hunk/session-broker-core": "workspace:*",
        typescript: "5.9.3",
      },
    }),
  );
  return root;
}

describe("source npm package staging", () => {
  test("keeps the workspace build graph out of the published manifest", () => {
    const source = createTestPackage();
    const destination = path.join(source, "staged");

    stageSourceNpmPackage(destination, source);

    const manifest = JSON.parse(readFileSync(path.join(destination, "package.json"), "utf8"));
    expect(manifest.devDependencies).toEqual({ typescript: "5.9.3" });
    expect(manifest.scripts).toBeUndefined();
    expect(readFileSync(path.join(destination, "dist", "npm", "fixture"), "utf8")).toBe("dist/npm");
  });
});
