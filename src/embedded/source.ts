import { isDeepStrictEqual } from "node:util";
import { resolveConfiguredCliInput } from "../core/config";
import type { CliInput, CommonOptions } from "../core/types";
import type { EmbeddedHunkOptions, EmbeddedHunkSource } from "./types";

/** Return a defensive copy of embedded options. */
function normalizeOptions(options: EmbeddedHunkOptions | undefined): CommonOptions {
  return options ? { ...options } : {};
}

/** Return a copy of optional pathspecs so source identity cannot be mutated externally. */
function normalizePathspecs(pathspecs: string[] | undefined) {
  return pathspecs ? [...pathspecs] : undefined;
}

/** Normalize one embedded source into the canonical shape Hunk stores on a session. */
export function normalizeEmbeddedHunkSource(source: EmbeddedHunkSource): EmbeddedHunkSource {
  const options = normalizeOptions(source.options);

  switch (source.kind) {
    case "worktree":
      return { kind: "worktree", pathspecs: normalizePathspecs(source.pathspecs), options };
    case "staged":
      return { kind: "staged", pathspecs: normalizePathspecs(source.pathspecs), options };
    case "vcs":
      return {
        kind: "vcs",
        range: source.range,
        staged: source.staged,
        pathspecs: normalizePathspecs(source.pathspecs),
        options,
      };
    case "show":
      return {
        kind: "show",
        ref: source.ref,
        pathspecs: normalizePathspecs(source.pathspecs),
        options,
      };
    case "stash-show":
      return { kind: "stash-show", ref: source.ref, options };
    case "diff":
      return { kind: "diff", left: source.left, right: source.right, options };
    case "patch":
      return {
        kind: "patch",
        file: source.file,
        text: source.text,
        label: source.label,
        options,
      };
    case "difftool":
      return {
        kind: "difftool",
        left: source.left,
        right: source.right,
        path: source.path,
        options,
      };
  }
}

/** Adapt a public embedded source into the internal CLI input pipeline. */
export function embeddedSourceToCliInput(source: EmbeddedHunkSource): CliInput {
  const normalized = normalizeEmbeddedHunkSource(source);
  const options = normalized.options ?? {};

  switch (normalized.kind) {
    case "worktree":
      return {
        kind: "vcs",
        staged: false,
        pathspecs: normalized.pathspecs,
        options,
      };
    case "staged":
      return {
        kind: "vcs",
        staged: true,
        pathspecs: normalized.pathspecs,
        options,
      };
    case "patch":
      return {
        kind: "patch",
        text: normalized.text,
        file: normalized.file ?? normalized.label,
        options,
      };
    default:
      return { ...normalized, options } as CliInput;
  }
}

/** Resolve embedded input through the same config layers as the CLI. */
export function resolveEmbeddedCliInput(source: EmbeddedHunkSource, cwd: string) {
  return resolveConfiguredCliInput(embeddedSourceToCliInput(source), { cwd }).input;
}

/** Return whether two embedded sources resolve to the same review identity. */
export function embeddedHunkSourcesEqual(left: EmbeddedHunkSource, right: EmbeddedHunkSource) {
  return isDeepStrictEqual(normalizeEmbeddedHunkSource(left), normalizeEmbeddedHunkSource(right));
}
