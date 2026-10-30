import { expect, test } from "bun:test";
import { win32 } from "node:path";
import { resolveWindowsNpmCommand } from "./npmCommand";

/** Build portable Windows lookup fixtures without starting platform-specific executables. */
function createWindowsNpmResolutionTest(cli?: string, actualNode?: string) {
  const probes: string[] = [];
  return {
    probes,
    exists: (path: string) => path === cli,
    probeNodeExecutable: (node: string) => {
      probes.push(node);
      return actualNode;
    },
  };
}

test("executes a native npm.exe shim directly without requiring a neighboring npm-cli.js", () => {
  const npm = win32.join("C:\\", "Volta", "bin", "npm.exe");
  const io = createWindowsNpmResolutionTest();
  expect(resolveWindowsNpmCommand(npm, null, {}, io)).toEqual([npm]);
  expect(io.probes).toEqual([]);
});

test("resolves npm.cmd through Node without introducing cmd.exe or shell interpretation", () => {
  const directory = win32.join("C:\\", "Program Files", "nodejs");
  const npm = win32.join(directory, "npm.cmd");
  const node = win32.join(directory, "node.exe");
  const cli = win32.join(directory, "node_modules", "npm", "bin", "npm-cli.js");
  const io = createWindowsNpmResolutionTest(cli);
  expect(resolveWindowsNpmCommand(npm, node, {}, io)).toEqual([node, cli]);
  expect(io.probes).toEqual([]);
});

test("finds the active Node installation behind npm.cmd and node.exe shims", () => {
  const shims = win32.join("C:\\", "Scoop", "shims");
  const actualNode = win32.join("C:\\", "Scoop", "apps", "nodejs", "current", "node.exe");
  const cli = win32.join(win32.dirname(actualNode), "node_modules", "npm", "bin", "npm-cli.js");
  const node = win32.join(shims, "node.exe");
  const io = createWindowsNpmResolutionTest(cli, actualNode);
  expect(resolveWindowsNpmCommand(win32.join(shims, "npm.cmd"), node, {}, io)).toEqual([node, cli]);
  expect(io.probes).toEqual([node]);
});

test("uses npm beside a non-shim Node installation when npm.cmd is elsewhere", () => {
  const node = win32.join("C:\\", "nodejs", "node.exe");
  const cli = win32.join(win32.dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
  const io = createWindowsNpmResolutionTest(cli);
  expect(resolveWindowsNpmCommand(win32.join("C:\\", "shims", "npm.cmd"), node, {}, io)).toEqual([
    node,
    cli,
  ]);
  expect(io.probes).toEqual([]);
});

test("fails clearly rather than falling back to an unsafe command shell", () => {
  const npm = win32.join("C:\\", "shims", "npm.cmd");
  const node = win32.join("C:\\", "shims", "node.exe");
  expect(() => resolveWindowsNpmCommand(npm, null, {}, createWindowsNpmResolutionTest())).toThrow(
    /Node.js was not found/,
  );
  expect(() => resolveWindowsNpmCommand(npm, node, {}, createWindowsNpmResolutionTest())).toThrow(
    /Could not locate npm-cli.js/,
  );
});
