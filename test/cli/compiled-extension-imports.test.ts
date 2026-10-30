import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestOptionalPackageExtension,
  createTestPackageExtension,
  TEST_PACKAGE_EXTENSION_RESULT,
} from "../helpers/extensionPackageTestFixtures";

const root = mkdtempSync(join(tmpdir(), "hunk-compiled-extension-"));
const executable = join(root, process.platform === "win32" ? "loader.exe" : "loader");

beforeAll(() => {
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      "--no-compile-autoload-bunfig",
      join(import.meta.dir, "fixtures", "compiled-extension-imports.ts"),
      "--outfile",
      executable,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());

  createTestPackageExtension(root);
  createTestPackageExtension(root, join(root, "src"));
  createTestOptionalPackageExtension(root);
  const commonjsDirectory = join(root, "node_modules", "native-commonjs");
  mkdirSync(commonjsDirectory, { recursive: true });
  writeFileSync(
    join(commonjsDirectory, "package.json"),
    JSON.stringify({ name: "native-commonjs", main: "index.js" }),
  );
  writeFileSync(join(commonjsDirectory, "index.js"), `module.exports = { native: true };\n`);
  writeFileSync(
    join(root, "src", "native.ts"),
    `import value from "native-commonjs"; export default value;\n`,
  );
}, 30_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test.each(["index.ts", join("src", "index.ts")])(
  "loads folder packages and their host imports from %s in a compiled executable",
  (entryPath) => {
    const entry = join(root, entryPath);
    const proc = Bun.spawnSync([executable, entry], { stdout: "pipe", stderr: "pipe" });

    expect(proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString())).toEqual({
      result: TEST_PACKAGE_EXTENSION_RESULT,
      reexported: "feature",
      hostReact: true,
    });
  },
);

test("defers optional import and require failures until execution without bypassing exports", () => {
  const proc = Bun.spawnSync([executable, join(root, "optional.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
  expect(JSON.parse(proc.stdout.toString())).toEqual({
    result: { missing: true, blocked: true, required: true, unused: true },
    hostReact: true,
  });
});

test("preserves native CommonJS package format outside the extension source root", () => {
  const proc = Bun.spawnSync([executable, join(root, "src", "native.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
  expect(JSON.parse(proc.stdout.toString())).toEqual({
    result: { native: true },
    hostReact: false,
  });
});

test("rewrites dynamic-only ESM packages without changing their package format", () => {
  const directory = join(root, "node_modules", "dynamic-only");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "dynamic-only", type: "module", main: "index.js" }),
  );
  writeFileSync(
    join(directory, "index.js"),
    `globalThis.dynamicResult = (await import("fixture-pkg/feature")).default;\n`,
  );
  const entry = join(root, "src", "dynamic-only.ts");
  writeFileSync(
    entry,
    `import "dynamic-only"; export default { value: globalThis.dynamicResult };\n`,
  );
  const proc = Bun.spawnSync([executable, entry], { stdout: "pipe", stderr: "pipe" });

  expect(proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
  expect(JSON.parse(proc.stdout.toString())).toEqual({
    result: { value: "feature" },
    hostReact: false,
  });
});

test("reports the asynchronous-hook limitation for CommonJS source require in a compiled executable", () => {
  const entry = join(root, "commonjs.ts");
  writeFileSync(entry, `export default require("fixture-pkg/commonjs");\n`);
  const proc = Bun.spawnSync([executable, entry], { stdout: "pipe", stderr: "pipe" });

  expect(proc.exitCode).not.toBe(0);
  expect(proc.stderr.toString()).toContain("require() async module");
});

test("keeps unexported subpaths blocked in a compiled executable", () => {
  const entry = join(root, "blocked.ts");
  writeFileSync(entry, `import value from "fixture-pkg/blocked"; export default value;\n`);
  const proc = Bun.spawnSync([executable, entry], { stdout: "pipe", stderr: "pipe" });

  expect(proc.exitCode).not.toBe(0);
  expect(proc.stderr.toString()).toContain("fixture-pkg");
});
