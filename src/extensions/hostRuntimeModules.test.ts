import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { isValidElement, useState } from "react";
import { HunkExtensionUserError } from "../extension-api";
import { registerHostRuntimeModules } from "./hostRuntimeModules";

/**
 * These tests import real files from a temp directory, the way extension
 * loading does. The temp directory has no `node_modules` route to the repo's
 * React, so a bare `react` specifier resolving at all proves the virtual
 * module served it — and function identity proves it is *this* React, the
 * property that keeps extension hooks on the host's dispatcher.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeTempExtension(name: string, contents: string) {
  const dir = mkdtempSync(join(tmpdir(), "hunk-host-modules-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

async function importTempExtension(path: string) {
  registerHostRuntimeModules([path]);
  return (await import(pathToFileURL(path).href)) as { default: Record<string, unknown> };
}

describe("registerHostRuntimeModules", () => {
  test("serves the host React instance to a file outside the app bundle", async () => {
    const path = writeTempExtension(
      "ext.ts",
      `import { useState } from "react";\nexport default { useState };\n`,
    );

    const mod = await importTempExtension(path);

    expect(mod.default.useState).toBe(useState);
  });

  test("wins over a conflicting react adjacent to the extension file", async () => {
    const path = writeTempExtension(
      "ext.ts",
      `import { useState } from "react";\nexport default { useState };\n`,
    );
    // A repo-local extension inside a JavaScript project sits next to that
    // project's own React; resolving it would split the hooks dispatcher.
    const fakeReactDir = join(path, "..", "node_modules", "react");
    mkdirSync(fakeReactDir, { recursive: true });
    writeFileSync(
      join(fakeReactDir, "package.json"),
      JSON.stringify({ name: "react", version: "0.0.1", main: "index.js" }),
    );
    writeFileSync(join(fakeReactDir, "index.js"), "module.exports = { useState() {} };\n");

    const mod = await importTempExtension(path);

    expect(mod.default.useState).toBe(useState);
  });

  test("transpiled JSX lands on the host jsx runtime", async () => {
    const path = writeTempExtension(
      "ext.tsx",
      `function View() {\n` +
        `  return <text content="from extension" />;\n` +
        `}\n` +
        `export default { makeElement: () => <View /> };\n`,
    );

    const mod = await importTempExtension(path);
    const makeElement = mod.default.makeElement as () => unknown;

    // Valid under the host's React means the automatic-runtime import the
    // transpiler emitted (`react/jsx-runtime` or the dev variant) was served.
    expect(isValidElement(makeElement())).toBe(true);
  });

  test("serves hunkdiff/extension runtime values", async () => {
    const path = writeTempExtension(
      "ext.ts",
      `import { HunkExtensionUserError } from "hunkdiff/extension";\n` +
        `export default { HunkExtensionUserError };\n`,
    );

    const mod = await importTempExtension(path);

    expect(mod.default.HunkExtensionUserError).toBe(HunkExtensionUserError);
  });

  test("reaches helper modules imported by the entry file", async () => {
    const path = writeTempExtension(
      "ext.ts",
      `import { helperUseState } from "./helper";\nexport default { helperUseState };\n`,
    );
    writeFileSync(
      join(dirname(path), "helper.ts"),
      `import { useState } from "react";\nexport const helperUseState = useState;\n`,
    );

    const mod = await importTempExtension(path);

    expect(mod.default.helperUseState).toBe(useState);
  });

  test("does not claim bare specifiers outside registered extension directories", async () => {
    // The load hook is scoped per directory on purpose: a process-wide claim on
    // `react` breaks the host's own lazily imported modules when Hunk runs from
    // source. A file in an unregistered directory must keep normal resolution —
    // here, that means failing to find a package its directory does not have.
    registerHostRuntimeModules([writeTempExtension("registered.ts", "export default {};\n")]);
    const outsiderDir = mkdtempSync(join(tmpdir(), "hunk-host-modules-outside-"));
    tempDirs.push(outsiderDir);
    const outsider = join(outsiderDir, "outsider.ts");
    writeFileSync(outsider, `import "react";\nexport default {};\n`);

    await expect(import(pathToFileURL(outsider).href)).rejects.toThrow(/react/);
  });
});
