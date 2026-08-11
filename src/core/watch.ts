import fs from "node:fs";
import { resolve } from "node:path";
import { createVcsWatchSignature, getConfiguredVcsAdapter, operationFromInput } from "./vcs";
import type { CliInput } from "./types";
import type { VcsAdapter } from "./vcs/types";

/** Format one file stat into a stable signature fragment, or mark the path missing. */
function statSignature(path: string) {
  if (!fs.existsSync(path)) {
    return `${path}:missing`;
  }

  const stat = fs.statSync(path);
  return `${path}:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}

/** Build one exact patch signature for adapter-backed review inputs. */
function vcsPatchSignature(
  input: Extract<CliInput, { kind: "vcs" | "show" | "stash-show" }>,
  context: WatchSignatureContext,
) {
  const adapter = getConfiguredVcsAdapter(input.options.vcs, context.vcsAdapters);
  const operation = operationFromInput(input);
  return createVcsWatchSignature(adapter, operation, context);
}

export interface WatchSignatureContext {
  cwd: string;
  gitExecutable?: string;
  /** Extension-contributed adapters, so a watched review keeps its own backend. */
  vcsAdapters?: readonly VcsAdapter[];
  /** Abandon the check when the watcher closes before it finishes. */
  signal?: AbortSignal;
}

/**
 * Compute a change-detection signature relative to the source's stable load context.
 *
 * Asynchronous because watch mode re-runs this on every debounced file event and
 * every safety poll: an adapter that shells out — Git computes a whole patch —
 * would otherwise stall the terminal UI each time. Adapters may still answer
 * synchronously; this awaits either shape.
 */
export async function computeWatchSignature(input: CliInput, context: WatchSignatureContext) {
  const parts: string[] = [input.kind];
  const resolveInputPath = (path: string) => resolve(context.cwd, path);

  switch (input.kind) {
    case "vcs":
    case "show":
    case "stash-show":
      parts.push(await vcsPatchSignature(input, context));
      break;
    case "diff":
    case "difftool":
      parts.push(
        statSignature(resolveInputPath(input.left)),
        statSignature(resolveInputPath(input.right)),
      );
      break;
    case "patch":
      if (!input.file || input.file === "-") {
        throw new Error("Watch mode requires a patch file path instead of stdin.");
      }
      parts.push(statSignature(resolveInputPath(input.file)));
      break;
  }

  if (input.options.agentContext && input.options.agentContext !== "-") {
    parts.push(`agent:${statSignature(resolveInputPath(input.options.agentContext))}`);
  }

  return parts.join("\n---\n");
}
