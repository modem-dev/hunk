import { dirname, resolve } from "node:path";
import { HunkUserError } from "../../core/run/errors";
import { resolveConfiguredInput, persistedViewPreferencesFromOptions } from "../../core/run/config";
import type { OpenCommandInput } from "../../core/run/commandInputs";
import type { DocumentSource } from "../../core/documents/source";
import { createInteractiveSessionInitialization } from "../../core/session/initialization";
import { createFilesystemSource } from "./filesystemSource";

import type { DocumentBrowserBootstrap } from "../../core/documents/bootstrap";

/** Resolve document launch inputs without loading extensions, VCS providers or review state. */
export async function prepareDocumentBrowser(
  input: OpenCommandInput,
  cwd = process.cwd(),
  env = process.env,
): Promise<DocumentBrowserBootstrap> {
  let source: DocumentSource;
  try {
    source = await createFilesystemSource(resolve(cwd, input.path));
  } catch {
    throw new HunkUserError(`Cannot open ${input.path}: path is missing or unreadable.`);
  }
  const configured = resolveConfiguredInput(input, {
    cwd: source.root.kind === "directory" ? source.root.key : dirname(source.root.key),
    env,
  });
  return {
    source,
    configured,
    initialization: createInteractiveSessionInitialization({
      theme: {
        initialTheme: configured.input.options.theme,
        customThemes: configured.customThemes,
      },
      viewPreferences: persistedViewPreferencesFromOptions(configured.input.options),
    }),
  };
}
