#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import path from "node:path";
import { checkExtensionConsumerTypes } from "./extension-consumer-check";
import { buildDocExamples } from "./extension-doc-examples";
import { checkPackedPublicConsumers } from "./packed-public-consumer-check";
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
  ExtensionCommandControls,
  ExtensionCommandExecutionOptions,
  ExtensionFileLanguageMatcher,
  ExtensionFileViewRow,
  ExtensionFileViewRowComponentProps,
  ExtensionFileViewSourceRange,
  ExtensionKeyboardModeControls,
  ExtensionKeyboardModeKeyResult,
  ExtensionLineHighlight,
  ExtensionLineHighlightTone,
  ExtensionPaintTheme,
  ExtensionHorizontalPane,
  ExtensionPaneProps,
  ExtensionPaneSize,
  ExtensionReviewSelection,
  ExtensionSessionOptions,
  ExtensionVerticalPane,
  ExtensionVcsAdapter,
  ExtensionVcsDiffInput,
  ExtensionVcsLoadContext,
  ExtensionVcsPatchResult,
  ExtensionWorkspaceWriteResult,
  HunkExtensionAPI,
  NamedCustomThemeConfig,
} from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  const sessionOptions: ExtensionSessionOptions = { viewPreferences: "transient" };
  hunk.configureSession(sessionOptions);
  const noSelection: ExtensionReviewSelection = {
    file: null,
    hunkIndex: null,
    currentLine: null,
  };
  hunk.log(noSelection.file === null ? "nothing selected" : noSelection.file.path);
  hunk.log(noSelection.currentLine?.side ?? "no current line");
  hunk.registerCliCommand(
    { name: "review-tools", summary: "Prepare or inspect a review", usage: "<action>" },
    async (args, ctx) => {
      if (args[0] === "review") {
        await ctx.stderr.write("Preparing review…\\n");
        return { kind: "delegate", argv: ["diff"] };
      }
      await ctx.stdout.write(new TextEncoder().encode(ctx.cwd + "\\n"));
      return { kind: "exit", code: ctx.signal.aborted ? 1 : 0 };
    },
  );

  const theme: NamedCustomThemeConfig = {
    id: "midnight-review",
    label: "Midnight Review",
    base: "catppuccin-mocha",
    accent: "#7fd1ff",
    syntaxScopes: { "keyword.operator": "#7fd1ff" },
  };
  hunk.registerTheme(theme);
  hunk.registerFileLanguage(".zig", "zig");
  const generatedTypeScript: ExtensionFileLanguageMatcher = {
    kind: "glob",
    value: "generated/**/*.ts",
    target: "path",
  };
  hunk.registerFileLanguage(generatedTypeScript, "typescript");

  const pane = (props: ExtensionPaneProps) => {
    hunk.log(\`\${props.placement}:\${props.width}x\${props.height}\`);
    props.currentLine?.render("new", props.width);
    hunk.log(props.currentLine ? props.currentLine.side + ":" + props.currentLine.line : "no line");
    return null;
  };
  const paneSize: ExtensionPaneSize = { preferred: 3, min: 2, max: 4, fraction: 0.25 };
  for (const placement of ["left", "right"] as const) {
    const verticalPane: ExtensionVerticalPane = {
      id: placement,
      placement,
      width: paneSize,
      component: pane,
    };
    hunk.registerPane(verticalPane);
  }
  for (const placement of ["top", "bottom"] as const) {
    const horizontalPane: ExtensionHorizontalPane = {
      id: placement,
      placement,
      height: paneSize,
      currentLine: placement === "bottom",
      component: pane,
    };
    hunk.registerPane(horizontalPane);
  }
  hunk.registerSidebarView({
    id: "legacy",
    placement: "right",
    component: ({ files, width }) => {
      hunk.log(\`legacy:\${files.length}:\${width}\`);
      return null;
    },
  });

  const renderRow = (props: ExtensionFileViewRowComponentProps) => {
    const paintTheme: ExtensionPaintTheme = props.theme;
    hunk.log(paintTheme.text);
    return null;
  };
  const sourceRange: ExtensionFileViewSourceRange = { side: "new", range: [1, 1] };
  const componentRow: ExtensionFileViewRow = {
    id: "component",
    spans: [{ text: "fallback" }],
    sourceRanges: [sourceRange],
    component: { height: 2, render: renderRow },
  };
  const invalidComponentRow: ExtensionFileViewRow = {
    id: "invalid",
    spans: [],
    // @ts-expect-error Height and render cannot be unpaired in a component descriptor.
    component: { height: 1 },
  };
  void invalidComponentRow;
  const invalidToneRow: ExtensionFileViewRow = {
    id: "invalid-tone",
    // @ts-expect-error Ordinary text omits tone; "text" is not a semantic tone.
    spans: [{ text: "invalid", tone: "text" }],
  };
  void invalidToneRow;
  hunk.registerFileView({
    id: "raw",
    title: "A view whose extension id is raw",
    matches: (file) => file.path.endsWith(".md"),
    async layout(input) {
      const document: string | null = await input.readDocument("new");
      const firstRange: readonly [number, number] | undefined = input.changes[0]?.range;
      const firstChange = input.changes[0];
      if (firstChange) {
        // @ts-expect-error File-view ranges are immutable tuples.
        firstChange.range[0] = 1;
      }
      // @ts-expect-error The single layout input is readonly.
      input.width = 1;
      hunk.log(document ?? String(firstRange?.[0] ?? input.width));
      return {
        rows: [componentRow],
        hunkRows: (input.file.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
      };
    },
  });
  const matchTone: ExtensionLineHighlightTone = "match";
  hunk.registerLineHighlighter({
    id: "needles",
    async highlight(input) {
      const document: string | null = await input.readDocument("old");
      hunk.log(document === null ? input.file.path : "read old side");
      const mark: ExtensionLineHighlight = {
        side: "new",
        line: 1,
        range: [0, 4],
        tone: matchTone,
      };
      const otherTones: ExtensionLineHighlightTone[] = [
        "current",
        "info",
        "warning",
        "error",
        "dim",
      ];
      hunk.log(String(otherTones.length));
      // @ts-expect-error Ranges are immutable tuples.
      mark.range[0] = 2;
      return [mark];
    },
  });
  hunk.registerKeyboardMode({
    id: "review-keys",
    title: "Review keys",
    onKey(key, ctx): ExtensionKeyboardModeKeyResult {
      if (key.name !== "j") return "pass";
      ctx.commands.execute("hunk.review.stepDown");
      return "handled";
    },
  });
  hunk.registerCommand({ id: "raw-view", title: "Raw view" }, (ctx) => {
    const commandControls: ExtensionCommandControls = ctx.commands;
    const modeControls: ExtensionKeyboardModeControls = ctx.keyboardModes;
    const execution: ExtensionCommandExecutionOptions = { count: 2 };
    if (commandControls.isEnabled("hunk.review.nextHunk")) {
      const executed: boolean = commandControls.execute("hunk.review.nextHunk", execution);
      hunk.log(executed ? "moved" : "not moved");
    }
    // @ts-expect-error Count must be numeric.
    commandControls.execute("hunk.review.nextHunk", { count: "two" });
    ctx.fileViews.select("raw");
    ctx.fileViews.select(null);
    ctx.fileViews.refresh("raw");
    if (ctx.fileViews.isActive("raw") && !ctx.fileViews.isModeActive("raw")) {
      const entered: boolean = ctx.fileViews.enterMode("raw");
      hunk.log(entered ? "mode running" : "mode refused");
    }
    ctx.fileViews.exitMode();
    ctx.highlights.refresh("needles");
    ctx.highlights.refresh("needles", { fileId: ctx.selection.file?.id ?? "" });
    if (!modeControls.isActive("review-keys")) {
      modeControls.enterMode("review-keys");
    }
    modeControls.exitMode();
    ctx.panes.toggle("bottom");
    if (ctx.sidebars.isOpen("legacy")) ctx.sidebars.close("legacy");

    const targetFile = ctx.selection.file;
    if (targetFile) {
      ctx.navigation.selectFile(targetFile.id);
      ctx.navigation.selectHunk(targetFile.id, 0);
      ctx.navigation.revealLine(targetFile.id, "new", 211);
      ctx.navigation.revealLine(targetFile.id, "old", 1);
      // @ts-expect-error Only the two diff sides address a line.
      ctx.navigation.revealLine(targetFile.id, "both", 1);
    }
  });

  hunk.registerCommand({ id: "rewrite", title: "Rewrite the selection" }, async (ctx) => {
    const file = ctx.selection.file;
    if (!file || !ctx.workspace.canWriteDocument(file.id)) {
      return;
    }

    // A read answers with the document or with nothing; a side outside the
    // union is a compile error rather than a runtime surprise.
    const current: string | null = await ctx.workspace.readDocument(file.id, "new");
    // @ts-expect-error Only the two document sides can be read.
    void ctx.workspace.readDocument(file.id, "both");

    const written: ExtensionWorkspaceWriteResult = await ctx.workspace.writeDocument({
      fileId: file.id,
      text: (current ?? "").toUpperCase(),
    });
    // The result is a discriminated union: \`detail\` exists only on refusals.
    hunk.log(written.ok ? "written" : written.detail);
  });

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
            readFileSource: async ({ path, side }) =>
              side === "old"
                ? null
                : path.endsWith(".generated")
                  ? { kind: "too-large", maxBytes: 1_000_000 }
                  : path,
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

  hunk.on("startup", async (event, ctx) => {
    ctx.notify(\`started in \${event.cwd}\`, "info");
    if (await ctx.dialogs.confirm({ title: "Reveal the first line?" })) {
      ctx.navigation.revealLine("file-id", "new", 1);
    }
  });
  hunk.on("command_executed", ({ commandId }) => {
    hunk.log(\`terminal command \${commandId}\`);
  });
  hunk.on("changeset_loaded", (event) => {
    hunk.log(\`loaded \${event.changeset.files.length} files\`);
  });
  hunk.on("selection_changed", (event) => {
    hunk.log(\`selected \${event.fileId ?? "nothing"} #\${event.hunkIndex ?? -1}\`);
  });
  hunk.on("hunk_viewed", (event) => {
    hunk.log(\`viewed hunk \${event.hunkIndex} in \${event.file.path}\`);
  });
  hunk.on("note_changed", (event) => {
    hunk.log(\`note \${event.kind} \${event.note.id}\`);
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

const appRoot = path.join(repoRoot, "packages", "hunk");
const proc = Bun.spawnSync([npmCommand, "pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: appRoot,
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
  // The bundled skills must survive the narrowed per-skill files entries —
  // `hunk skill path [name]` resolves them at runtime.
  "skills/hunk-review/SKILL.md",
  "skills/hunk-extensions/SKILL.md",
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
  // Maintainer-only workflows reference repository scripts and never ship.
  "skills/hunk-launch-video/",
  "skills/hunk-release/",
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
        "The hunkdiff/extension entry must only reach packages/hunk/src/extension-api.",
    );
  }
}

if (pack.name !== "hunkdiff") {
  throw new Error(`Expected npm package name to be hunkdiff, got ${pack.name}.`);
}

const extensionTypes = readFileSync(
  path.join(appRoot, "dist", "npm", "extension", "extension-api", "types.d.ts"),
  "utf8",
);
if (/^\s*import\b/m.test(extensionTypes)) {
  throw new Error("The public extension-api/types declaration must remain import-free.");
}
for (const removedType of [
  "ExtensionExactFileDocument",
  "ExtensionFileDocuments",
  "ExtensionFileViewHunkBounds",
  "ExtensionFileViewLayoutContext",
  "ExtensionFileViewTextAttribute",
  "ExtensionFileViewTone",
]) {
  if (extensionTypes.includes(removedType)) {
    throw new Error(`Removed file-view helper type was emitted: ${removedType}`);
  }
}

// The allowlist above proves the published extension surface contains only what
// it should. This proves it is actually *usable*: a consumer compiling against
// the declarations, under both the strict Node ESM resolution and the permissive
// bundler one. `nodenext` is the one that catches extensionless relative
// specifiers in the emitted declarations, which the repo's own typecheck cannot
// see because it resolves TypeScript sources, not the shipped .d.ts tree.
const publishedManifest = readFileSync(path.join(appRoot, "package.json"), "utf8");
if (publishedManifest.includes("workspace:") || publishedManifest.includes('"@hunk/')) {
  throw new Error("The published hunkdiff manifest must not contain private workspace references.");
}
const publishedPackage = JSON.parse(publishedManifest) as { pi?: { skills?: string[] } };
if (JSON.stringify(publishedPackage.pi?.skills) !== JSON.stringify(["./skills"])) {
  throw new Error("The published hunkdiff manifest must expose its bundled Pi skills.");
}
for (const fileName of ["README.md", "LICENSE"]) {
  if (
    readFileSync(path.join(repoRoot, fileName), "utf8") !==
    readFileSync(path.join(appRoot, fileName), "utf8")
  ) {
    throw new Error(`${fileName} in packages/hunk must match the repository canonical copy.`);
  }
}

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
const packedModes = checkPackedPublicConsumers(repoRoot);
console.log(
  `Verified packed hunkdiff/extension and hunkdiff/opentui under ${packedModes.join(" and ")}.`,
);
