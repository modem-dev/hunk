#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import path from "node:path";
import { checkExtensionConsumerTypes } from "./extension-consumer-check";
import { buildDocExamples } from "./extension-doc-examples";
import { npmCommand } from "./script-helpers";

const repoRoot = path.resolve(import.meta.dir, "..");

/**
 * A representative extension, written the way an author would write one.
 *
 * Deliberately exercises the whole authoring surface — themes, languages, a VCS
 * adapter with operations and a watch plan, a transform, event handlers — so a
 * type that stops being exported, or stops being usable, fails the pack rather
 * than reaching npm.
 */
const CONSUMER_SOURCE = `
import {
  HUNK_CORE_VCS_DETECTION_PRIORITY,
  HunkExtensionUserError,
} from "hunkdiff/extension";
import type {
  ExtensionChangeset,
  ExtensionVcsAdapter,
  ExtensionVcsDiffInput,
  ExtensionVcsLoadContext,
  ExtensionVcsPatchResult,
  HunkExtensionAPI,
  NamedCustomThemeConfig,
} from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  const theme: NamedCustomThemeConfig = {
    id: "midnight-review",
    label: "Midnight Review",
    base: "catppuccin-mocha",
    accent: "#7fd1ff",
    syntaxScopes: { "keyword.operator": "#7fd1ff" },
  };
  hunk.registerTheme(theme);
  hunk.registerFileLanguage(".zig", "zig");

  const adapter: ExtensionVcsAdapter = {
    id: "hg",
    name: "Mercurial",
    detectionPriority: HUNK_CORE_VCS_DETECTION_PRIORITY + 10,
    detect: (cwd: string) => (cwd.length > 0 ? { id: "hg", repoRoot: cwd } : null),
    operations: {
      "working-tree-diff": {
        async load(
          input: ExtensionVcsDiffInput,
          ctx: ExtensionVcsLoadContext,
        ): Promise<ExtensionVcsPatchResult> {
          if (input.staged) {
            throw new HunkExtensionUserError("Mercurial has no staging area.", {
              suggestions: ["Review the working copy instead."],
            });
          }

          return {
            repoRoot: ctx.cwd,
            sourceLabel: ctx.cwd,
            title: "Mercurial working copy",
            patchText: "",
            untrackedPaths: [],
            readFileSource: async ({ path, side }) => (side === "old" ? null : path),
            extraFiles: [
              { kind: "patch", path: "notes.md", patchText: "", isUntracked: true },
              {
                kind: "skipped",
                path: "dist/bundle.js",
                reason: "too-large",
                changeType: "change",
                stats: { additions: 1, deletions: 0 },
              },
            ],
          };
        },
        watchSignature: (_input, ctx) => ctx.cwd,
        watchPlan: (_input, ctx) => ({
          coverage: "hybrid",
          targets: [
            {
              kind: "directory-tree",
              directory: ctx.cwd,
              ignoredRoots: [],
              sources: ["worktree"],
            },
          ],
        }),
      },
    },
  };
  hunk.registerVcsAdapter(adapter);

  hunk.transformChangeset((changeset: ExtensionChangeset) => ({
    ...changeset,
    files: changeset.files.filter((file) => !file.path.endsWith(".lock")),
  }));

  hunk.on("startup", (event, ctx) => {
    ctx.notify(\`started in \${event.cwd}\`, "info");
  });
  hunk.on("changeset_loaded", (event) => {
    hunk.log(\`loaded \${event.changeset.files.length} files\`);
  });
  hunk.on("selection_changed", (event) => {
    hunk.log(\`selected \${event.fileId ?? "nothing"} #\${event.hunkIndex ?? -1}\`);
  });
  hunk.on("session_reload", (event) => {
    hunk.log(\`reloaded because \${event.reason}\`);
  });
  hunk.on("shutdown", () => {});
}
`;

interface PackedFile {
  path: string;
  size: number;
}

interface PackResult {
  name: string;
  version: string;
  filename: string;
  entryCount: number;
  files: PackedFile[];
}

const proc = Bun.spawnSync([npmCommand, "pack", "--dry-run", "--json"], {
  cwd: process.cwd(),
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});

const stdout = Buffer.from(proc.stdout).toString("utf8").trim();
const stderr = Buffer.from(proc.stderr).toString("utf8").trim();

if (proc.exitCode !== 0) {
  throw new Error(stderr || stdout || "npm pack --dry-run failed");
}

const jsonMatch = stdout.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/);
const jsonText = jsonMatch?.[1];

if (!jsonText) {
  throw new Error(`Could not find npm pack JSON output. Full stdout:\n${stdout}`);
}

const parsed = JSON.parse(jsonText) as PackResult[];
const pack = parsed[0];

if (!pack) {
  throw new Error("npm pack --dry-run returned no pack result.");
}

const publishedPaths = new Set(pack.files.map((file) => file.path));
const requiredPaths = [
  "bin/hunk.cjs",
  "dist/npm/main.js",
  "dist/npm/extension/index.d.ts",
  "dist/npm/extension/index.js",
  "dist/npm/opentui/index.d.ts",
  "dist/npm/opentui/index.js",
  "README.md",
  "LICENSE",
  "package.json",
];

for (const path of requiredPaths) {
  if (!publishedPaths.has(path)) {
    throw new Error(`Expected npm package to include ${path}.`);
  }
}

const forbiddenPrefixes = [
  ".github/",
  "src/",
  "test/",
  "scripts/",
  "tmp/",
  "dist/npm/core/",
  "dist/npm/ui/",
];
const forbiddenPaths = ["AGENTS.md", "bun.lock"];

for (const file of pack.files) {
  if (
    forbiddenPrefixes.some((prefix) => file.path.startsWith(prefix)) ||
    forbiddenPaths.includes(file.path)
  ) {
    throw new Error(`Unexpected file in npm package: ${file.path}`);
  }
}

// `hunkdiff/extension` is a façade: its declarations must describe the authoring
// contract and nothing else. Whole-program declaration emission happily ships
// every module the entry reaches, so the published tree is allowlisted here —
// a stray `extension/core/**` or `extension/extensions/**` file means the entry
// grew an import into Hunk's internals and leaked them to consumers.
const extensionPrefix = "dist/npm/extension/";
const allowedExtensionEntries = ["index.js", "index.d.ts"];
const allowedExtensionPrefixes = ["extension-api/"];

for (const file of pack.files) {
  if (!file.path.startsWith(extensionPrefix)) {
    continue;
  }

  const relativePath = file.path.slice(extensionPrefix.length);
  if (
    !allowedExtensionEntries.includes(relativePath) &&
    !allowedExtensionPrefixes.some((prefix) => relativePath.startsWith(prefix))
  ) {
    throw new Error(
      `Unexpected file in the published extension surface: ${file.path}. ` +
        "The hunkdiff/extension entry must only reach src/extension-api.",
    );
  }
}

if (pack.name !== "hunkdiff") {
  throw new Error(`Expected npm package name to be hunkdiff, got ${pack.name}.`);
}

// The allowlist above proves the published extension surface contains only what
// it should. This proves it is actually *usable*: a consumer compiling against
// the declarations, under both the strict Node ESM resolution and the permissive
// bundler one. `nodenext` is the one that catches extensionless relative
// specifiers in the emitted declarations, which the repo's own typecheck cannot
// see because it resolves TypeScript sources, not the shipped .d.ts tree.
const docsMarkdown = readFileSync(path.join(repoRoot, "docs", "extensions.md"), "utf8");
const docExamples = buildDocExamples(docsMarkdown);

const { modes } = checkExtensionConsumerTypes({
  repoRoot,
  sources: [
    { name: "consumer.ts", text: CONSUMER_SOURCE },
    ...docExamples.map((example) => ({ name: example.name, text: example.text })),
  ],
});

console.log(
  `Verified npm pack output for ${pack.name}@${pack.version} (${pack.entryCount} files).`,
);
console.log(
  `Verified hunkdiff/extension typechecks for consumers using ${modes
    .map((mode) => `moduleResolution: "${mode}"`)
    .join(" and ")}, ` + `across ${docExamples.length} docs/extensions.md examples.`,
);
