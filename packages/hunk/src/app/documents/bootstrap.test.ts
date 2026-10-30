import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCli } from "../cli";
import { prepareStartupPlan } from "../startup";
import { prepareDocumentBrowser } from "./bootstrap";
import { resolveConfiguredInput } from "../../core/run/config";

const roots: string[] = [];
/** Create a project with an isolated config source for open-workflow tests. */
function createOpenBootstrapTestRoot() {
  const root = mkdtempSync(join(tmpdir(), "hunk-open-bootstrap-"));
  roots.push(root);
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("open is a built-in defaulting to . and rejects extra paths instead of delegating to extensions", async () => {
  expect(await parseCli(["bun", "hunk", "open"])).toMatchObject({ kind: "open", path: "." });
  expect(
    await parseCli(["bun", "hunk", "open", "file.ts", "--theme", "nord", "--no-line-numbers"]),
  ).toMatchObject({
    kind: "open",
    path: "file.ts",
    options: { theme: "nord", lineNumbers: false },
  });
  expect(await parseCli(["bun", "hunk", "open", "--help"])).toMatchObject({ kind: "help" });
  await expect(parseCli(["bun", "hunk", "open", "a", "b"])).rejects.toThrow();
});

test("open config uses its own section, file location and shared user keybindings without loading repo code", async () => {
  const root = createOpenBootstrapTestRoot();
  const configHome = createOpenBootstrapTestRoot();
  mkdirSync(join(root, ".hunk"));
  mkdirSync(join(configHome, "hunk"));
  writeFileSync(join(root, "README.md"), "whole document\n");
  writeFileSync(
    join(root, ".hunk", "config.toml"),
    '[open]\ntheme = "nord"\nline_numbers = false\n[extensions]\npaths = ["./must-not-execute.ts"]\n',
  );
  writeFileSync(
    join(configHome, "hunk", "config.toml"),
    '[keybindings]\n"hunk.documents.stepDown" = "ctrl+n"\n',
  );
  const bootstrap = await prepareDocumentBrowser(
    { kind: "open", path: join(root, "README.md"), options: {} },
    configHome,
    { ...process.env, XDG_CONFIG_HOME: configHome },
  );
  expect(bootstrap.source.root.kind).toBe("file");
  expect(bootstrap.configured.input.options.theme).toBe("nord");
  expect(bootstrap.configured.input.options.lineNumbers).toBe(false);
  expect(bootstrap.configured.keybindings["hunk.documents.stepDown"]).toBe("ctrl+n");
  expect(bootstrap.initialization.theme.initialTheme).toBe("nord");
  const generic = resolveConfiguredInput(
    { kind: "open", path: root, options: {} },
    { cwd: root, env: { XDG_CONFIG_HOME: configHome } },
  );
  expect(generic.input.options.lineNumbers).toBe(false);
});

test("open startup requires terminal ownership and returns a document plan, not a changeset", async () => {
  const root = createOpenBootstrapTestRoot();
  const argv = ["bun", "hunk", "open", root];
  await expect(prepareStartupPlan(argv, { stdinIsTTY: false, stdoutIsTTY: true })).rejects.toThrow(
    "requires a terminal",
  );
  const plan = await prepareStartupPlan(argv, {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    env: { XDG_CONFIG_HOME: root },
  });
  expect(plan.kind).toBe("documents");
  if (plan.kind === "documents") expect("changeset" in plan.bootstrap).toBe(false);
  await expect(
    prepareDocumentBrowser({ kind: "open", path: join(root, "missing"), options: {} }),
  ).rejects.toThrow("missing or unreadable");
});
