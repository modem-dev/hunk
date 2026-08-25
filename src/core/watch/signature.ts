import fs from "node:fs";
import { resolve } from "node:path";
import { createVcsWatchSignature, getConfiguredVcsAdapter, operationFromInput } from "../vcs";
import type { CliInput } from "../run/commandInputs";
import type { VcsCatalog } from "../vcs/types";

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
  if (!context.vcsCatalog) {
    throw new Error("VCS-backed watch signatures require a composed VCS catalog.");
  }
  const adapter = getConfiguredVcsAdapter(input.options.vcs, context.vcsCatalog);
  const operation = operationFromInput(input);
  return createVcsWatchSignature(adapter, operation, { cwd: context.cwd }, context.vcsCatalog);
}

export interface WatchSignatureContext {
  cwd: string;
  /** Complete catalog retained from the review load. */
  vcsCatalog?: VcsCatalog;
}

/** Compute a change-detection signature relative to the source's stable load context. */
export function computeWatchSignature(input: CliInput, context: WatchSignatureContext) {
  const parts: string[] = [input.kind];
  const resolveInputPath = (path: string) => resolve(context.cwd, path);

  switch (input.kind) {
    case "vcs":
    case "show":
    case "stash-show":
      parts.push(vcsPatchSignature(input, context));
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
