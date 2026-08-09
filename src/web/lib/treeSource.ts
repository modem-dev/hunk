/** @jsxImportSource react */
import {
  FileTree as PierreTreeModel,
  preparePresortedFileTreeInput,
  themeToTreeStyles,
  type FileTreeDirectoryHandle,
  type GitStatus,
} from "@pierre/trees";
import { FileTree as PierreTreeReact } from "@pierre/trees/react";
import { createElement, useEffect, type CSSProperties } from "react";
import type { ReviewNoteV1 } from "../../core/review/types";
import type { BrowserReviewDocument, BrowserReviewFile } from "./reviewTypes";
import type { HunkWebTheme } from "./theme";

interface TreeFileDecoration {
  stats: string;
  noteCount: number;
  binary: boolean;
  tooLarge: boolean;
  canonicalPath: string;
  previousPath?: string;
}

export interface ReviewTreeIdentity {
  fileKey: string;
  canonicalPath: string;
  treePath: string;
}

export interface ReviewTreeSource {
  model: PierreTreeModel;
  pathToFileKey: Map<string, string>;
  fileKeyToPath: Map<string, string>;
  decorations: Map<string, TreeFileDecoration>;
  reset(
    document: BrowserReviewDocument,
    notes: readonly ReviewNoteV1[],
    selectedKey?: string,
  ): string | undefined;
  selectFile(key: string | undefined): void;
}

/** Preserve every duplicate canonical path by allocating invisible leaf-only tree identities. */
export function buildReviewTreeIdentities(files: readonly BrowserReviewFile[]) {
  const totals = new Map<string, number>();
  const occurrences = new Map<string, number>();
  for (const file of files) totals.set(file.path, (totals.get(file.path) ?? 0) + 1);
  return files.map((file): ReviewTreeIdentity => {
    const occurrence = occurrences.get(file.path) ?? 0;
    occurrences.set(file.path, occurrence + 1);
    return {
      fileKey: file.key,
      canonicalPath: file.path,
      treePath:
        totals.get(file.path) === 1 ? file.path : `${file.path}${invisibleOccurrence(occurrence)}`,
    };
  });
}

/** Map a canonical path to all semantic entries in authoritative order. */
export function buildReviewPathMap(files: readonly BrowserReviewFile[]) {
  const result = new Map<string, string[]>();
  for (const file of files) result.set(file.path, [...(result.get(file.path) ?? []), file.key]);
  return result;
}

/** Create the beta Trees model behind Hunk's narrow browser-only adapter. */
export function createReviewTreeSource(
  document: BrowserReviewDocument,
  notes: readonly ReviewNoteV1[],
  onSelectFile: (fileKey: string) => void,
): ReviewTreeSource {
  const identities = buildReviewTreeIdentities(document.files);
  const pathToFileKey = new Map(identities.map((entry) => [entry.treePath, entry.fileKey]));
  const fileKeyToPath = new Map(identities.map((entry) => [entry.fileKey, entry.treePath]));
  const decorations = new Map<string, TreeFileDecoration>();
  updateDecorations(decorations, document.files, identities, notes);
  let selectingProgrammatically = false;

  // Trees requires canonical presorted input. It cannot represent duplicate paths, so only the
  // colliding leaves receive invisible internal suffixes; labels remain the canonical path.
  const canonicalPreparedInput = preparePresortedFileTreeInput(
    document.files.map((file) => file.path),
  );
  const preparedInput = identities.some((entry) => entry.treePath !== entry.canonicalPath)
    ? preparePresortedFileTreeInput(identities.map((entry) => entry.treePath))
    : canonicalPreparedInput;
  const model = new PierreTreeModel({
    preparedInput,
    sort: () => 0,
    flattenEmptyDirectories: false,
    initialExpansion: 1,
    initialSelectedPaths: identities[0] ? [identities[0].treePath] : [],
    search: true,
    fileTreeSearchMode: "expand-matches",
    dragAndDrop: false,
    renaming: false,
    gitStatus: gitStatuses(document.files, identities),
    renderRowDecoration: ({ item }) => {
      const decoration = decorations.get(item.path);
      if (!decoration) return null;
      const flags = [
        decoration.binary ? "binary" : "",
        decoration.tooLarge ? "large" : "",
        decoration.noteCount
          ? `${decoration.noteCount} note${decoration.noteCount === 1 ? "" : "s"}`
          : "",
      ].filter(Boolean);
      return {
        text: [decoration.stats, flags.join(" · ")].filter(Boolean).join("  "),
        title: [
          decoration.previousPath
            ? `${decoration.previousPath} → ${decoration.canonicalPath}`
            : decoration.canonicalPath,
          flags.join(", "),
        ]
          .filter(Boolean)
          .join(" · "),
        parts: [
          { text: decoration.stats, color: "var(--hunk-muted)" },
          ...(flags.length ? [{ text: `  ${flags.join(" · ")}`, color: "var(--hunk-muted)" }] : []),
        ],
      };
    },
    onSelectionChange: (paths) => {
      if (selectingProgrammatically) return;
      const selectedPath = paths.at(-1);
      const fileKey = selectedPath ? pathToFileKey.get(selectedPath) : undefined;
      if (fileKey) onSelectFile(fileKey);
    },
    unsafeCSS: TREE_UNSAFE_CSS,
  });

  const source: ReviewTreeSource = {
    model,
    pathToFileKey,
    fileKeyToPath,
    decorations,
    reset(nextDocument, nextNotes, selectedKey) {
      const oldDirectories = directoryPaths(Array.from(pathToFileKey.keys()));
      const expanded = Array.from(oldDirectories).filter((path) => {
        const item = model.getItem(path);
        return item?.isDirectory() && (item as FileTreeDirectoryHandle).isExpanded();
      });
      const nextIdentities = buildReviewTreeIdentities(nextDocument.files);
      const nextPaths = nextIdentities.map((entry) => entry.treePath);
      const nextDirectories = directoryPaths(nextPaths);
      pathToFileKey.clear();
      fileKeyToPath.clear();
      for (const identity of nextIdentities) {
        pathToFileKey.set(identity.treePath, identity.fileKey);
        fileKeyToPath.set(identity.fileKey, identity.treePath);
      }
      updateDecorations(decorations, nextDocument.files, nextIdentities, nextNotes);
      const canonicalInput = preparePresortedFileTreeInput(
        nextDocument.files.map((file) => file.path),
      );
      model.resetPaths({
        preparedInput: nextIdentities.some((entry) => entry.treePath !== entry.canonicalPath)
          ? preparePresortedFileTreeInput(nextPaths)
          : canonicalInput,
        initialExpandedPaths: expanded.filter((path) => nextDirectories.has(path)),
      });
      model.setGitStatus(gitStatuses(nextDocument.files, nextIdentities));
      const retainedKey =
        selectedKey && nextDocument.files.some((file) => file.key === selectedKey)
          ? selectedKey
          : nextDocument.files[0]?.key;
      source.selectFile(retainedKey);
      return retainedKey;
    },
    selectFile(key) {
      const path = key ? fileKeyToPath.get(key) : undefined;
      if (!path) return;
      selectingProgrammatically = true;
      try {
        model.getItem(path)?.select();
        model.scrollToPath(path, { focus: false });
      } finally {
        selectingProgrammatically = false;
      }
    },
  };
  return source;
}

/** Render the beta React host without leaking its API outside this isolation module. */
export function ReviewFileTree({
  source,
  theme,
}: {
  source: ReviewTreeSource;
  theme: HunkWebTheme;
}) {
  useEffect(() => () => source.model.cleanUp(), [source]);
  const style = {
    ...themeToTreeStyles(theme),
    height: "100%",
    minHeight: 0,
    "--trees-selected-bg-override": "var(--hunk-selected)",
    "--trees-border-color-override": "var(--hunk-border)",
    "--trees-fg-override": "var(--hunk-fg)",
  } as CSSProperties;
  return createElement(PierreTreeReact, {
    "aria-label": "Changed files",
    model: source.model,
    style,
  });
}

function updateDecorations(
  target: Map<string, TreeFileDecoration>,
  files: readonly BrowserReviewFile[],
  identities: readonly ReviewTreeIdentity[],
  mutableNotes: readonly ReviewNoteV1[],
) {
  target.clear();
  for (const [index, file] of files.entries()) {
    const identity = identities[index]!;
    const noteCount =
      file.notes.length + mutableNotes.filter((note) => note.fileKey === file.key).length;
    target.set(identity.treePath, {
      stats: `+${file.additions} −${file.deletions}${file.statsTruncated ? "+" : ""}`,
      noteCount,
      binary: file.flags.binary,
      tooLarge: file.flags.tooLarge,
      canonicalPath: file.path,
      previousPath: file.previousPath,
    });
  }
}

function gitStatuses(
  files: readonly BrowserReviewFile[],
  identities: readonly ReviewTreeIdentity[],
) {
  return files.map((file, index) => ({
    path: identities[index]!.treePath,
    status: gitStatus(file),
  }));
}

function gitStatus(file: BrowserReviewFile): GitStatus {
  if (file.flags.untracked) return "untracked";
  if (file.changeKind === "new") return "added";
  if (file.changeKind === "deleted") return "deleted";
  if (file.changeKind === "rename-pure" || file.changeKind === "rename-changed") return "renamed";
  return "modified";
}

function directoryPaths(paths: readonly string[]) {
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return directories;
}

function invisibleOccurrence(value: number) {
  return `\u2063${String(value)
    .split("")
    .map((digit) => String.fromCodePoint(0xe0100 + Number(digit)))
    .join("")}`;
}

const TREE_UNSAFE_CSS = `
  button[data-type='item'] { border-radius: 5px; }
  button[data-type='item'][data-item-selected] { font-weight: 600; }
`;
