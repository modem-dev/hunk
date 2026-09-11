import { describe, expect, test } from "bun:test";
import { runExtensionFactory } from "../../extensions/runExtension";
import { HUNK_VENDOR_EXTENSION_ID } from "../../extensions/extensionIds";
import {
  createEmptyExtensionRegistry,
  type ExtensionFactory,
  type ExtensionLoadIssue,
  type ExtensionRegistry,
} from "../../extensions/types";
import {
  buildSessionCommands,
  buildSessionLineHighlighters,
  isBundledExtensionId,
} from "./sessionRegistrations";

/** Run one factory under an explicit extension identity into a fresh registry. */
function createTestRegistry(
  id: string,
  factory: ExtensionFactory,
  origin: "bundled" | "global" = "global",
): ExtensionRegistry {
  const registry = createEmptyExtensionRegistry();
  const issues: ExtensionLoadIssue[] = [];
  runExtensionFactory({
    metadata: { id, sourcePath: `test:${id}`, origin },
    registry,
    issues,
    factory,
  });
  expect(issues).toEqual([]);
  return registry;
}

/** A bundled-style registry with one command and one highlighter, like the search extension. */
function createTestBundledRegistry() {
  return createTestRegistry(
    HUNK_VENDOR_EXTENSION_ID,
    (hunk) => {
      hunk.registerLineHighlighter({ id: "marks", highlight: () => null });
      hunk.registerCommand({ id: "find", title: "Find", key: "/" }, () => {});
    },
    "bundled",
  );
}

describe("buildSessionCommands", () => {
  test("lists bundled commands before user commands so bundled keys win conflicts", () => {
    const user = createTestRegistry("acme", (hunk) => {
      hunk.registerCommand({ id: "find", title: "Find", key: "ctrl+f" }, () => {});
    });

    const commands = buildSessionCommands(user, createTestBundledRegistry());

    expect(commands.map((entry) => `${entry.extensionId}.${entry.command.id}`)).toEqual([
      "hunk.find",
      "acme.find",
    ]);
  });

  test("keeps bundled commands when user extensions are disabled or absent", () => {
    const bundled = createTestBundledRegistry();

    // `--no-extensions` yields an empty user registry; tests may mount with none.
    expect(
      buildSessionCommands(createEmptyExtensionRegistry(), bundled).map(
        (entry) => entry.command.id,
      ),
    ).toEqual(["find"]);
    expect(buildSessionCommands(undefined, bundled).map((entry) => entry.command.id)).toEqual([
      "find",
    ]);
  });
});

describe("buildSessionLineHighlighters", () => {
  test("lists bundled highlighters before user highlighters", () => {
    const user = createTestRegistry("acme", (hunk) => {
      hunk.registerLineHighlighter({ id: "marks", highlight: () => null });
    });

    const highlighters = buildSessionLineHighlighters(user, createTestBundledRegistry());

    expect(highlighters.map((entry) => `${entry.extensionId}:${entry.highlighter.id}`)).toEqual([
      "hunk:marks",
      "acme:marks",
    ]);
  });

  test("keeps bundled highlighters with no user extensions", () => {
    expect(
      buildSessionLineHighlighters(undefined, createTestBundledRegistry()).map(
        (entry) => entry.highlighter.id,
      ),
    ).toEqual(["marks"]);
  });
});

describe("isBundledExtensionId", () => {
  test("recognizes the vendor id without consulting the user registry", () => {
    expect(isBundledExtensionId(HUNK_VENDOR_EXTENSION_ID, undefined)).toBe(true);
    expect(isBundledExtensionId(HUNK_VENDOR_EXTENSION_ID, createEmptyExtensionRegistry())).toBe(
      true,
    );
  });

  test("recognizes bundled-origin entries in the user registry and nothing else", () => {
    const registry = createEmptyExtensionRegistry();
    registry.extensions.push({ id: "git", sourcePath: "hunk:bundled/git", origin: "bundled" });
    registry.extensions.push({ id: "acme", sourcePath: "/repo/acme.ts", origin: "repo" });

    expect(isBundledExtensionId("git", registry)).toBe(true);
    expect(isBundledExtensionId("acme", registry)).toBe(false);
    expect(isBundledExtensionId("missing", registry)).toBe(false);
  });
});
