import { resolve } from "node:path";
import type { CliInput, ReloadContext } from "../types";
import { reviewDigest } from "./identity";

/** Resolve user paths against the launch cwd without publishing them in review DTOs. */
function absoluteInputPath(path: string, cwd: string) {
  return resolve(cwd, path);
}

/**
 * Identify the launch/input source independently from user-visible changeset labels.
 *
 * Raw paths feed only hashed document and file identities; projection never exposes
 * this string through titles, labels, resources, or renderer-facing path fields.
 */
export function reviewInputSourceIdentity(input: CliInput, context: ReloadContext) {
  const cwd = context.cwd;
  switch (input.kind) {
    case "diff":
      return JSON.stringify([
        "review-input-v1",
        input.kind,
        absoluteInputPath(input.left, cwd),
        absoluteInputPath(input.right, cwd),
      ]);
    case "difftool":
      return JSON.stringify([
        "review-input-v1",
        input.kind,
        absoluteInputPath(input.left, cwd),
        absoluteInputPath(input.right, cwd),
        input.path ?? "",
      ]);
    case "patch":
      return JSON.stringify([
        "review-input-v1",
        input.kind,
        input.file && input.file !== "-" ? absoluteInputPath(input.file, cwd) : "stdin",
        input.text !== undefined ? reviewDigest(input.text) : "",
        context.repoRoot ?? cwd,
      ]);
    case "vcs":
      return JSON.stringify([
        "review-input-v1",
        input.kind,
        context.repoRoot ?? cwd,
        input.range ?? "",
        input.staged,
        input.pathspecs ?? [],
      ]);
    case "show":
      return JSON.stringify([
        "review-input-v1",
        input.kind,
        context.repoRoot ?? cwd,
        input.ref ?? "",
        input.pathspecs ?? [],
      ]);
    case "stash-show":
      return JSON.stringify([
        "review-input-v1",
        input.kind,
        context.repoRoot ?? cwd,
        input.ref ?? "",
      ]);
  }
}
