/**
 * The rules an extension id has to satisfy, in one import-free module.
 *
 * An extension id is a file stem the user chose, and it is the namespace that
 * id space owns everywhere else: `<extensionId>.<commandId>` for commands,
 * `<extensionId>:<paneId>` for panes, `[extension.<id>]` for config.
 * Two structural rules keep that from breaking down:
 *
 * - **One vendor namespace.** Everything Hunk itself owns lives under `hunk`,
 *   so an extension file can never mint an id that shadows a built-in, and new
 *   built-in groupings can be added forever without colliding with an id
 *   somebody already installed.
 * - **A parseable charset.** No dots, so `<extensionId>.<commandId>` splits at
 *   the first dot; no colons, so `<extensionId>:<paneId>` splits at the first
 *   colon; no leading separator, so ids read as names.
 *
 * The rules are enforced once, where candidates become loadable extensions
 * (`packages/hunk/src/extensions/host.ts`); this module only states them, so keymap code can
 * ask about the vendor namespace without pulling the loader in behind it.
 */

/** The id Hunk reserves for itself: built-in commands, panes, and bundled UI. */
export const HUNK_VENDOR_EXTENSION_ID = "hunk";
/** Stable key of the bundled files pane. */
export const HUNK_FILES_PANE_KEY = "hunk:files";

/**
 * Characters an extension id may be spelled with.
 *
 * Deliberately narrow: a stem outside this set is refused at load rather than
 * quietly producing ids nothing downstream can split apart again.
 */
const EXTENSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Human-readable statement of the charset rule, for load issues and docs. */
export const EXTENSION_ID_RULE =
  'ids must start with a letter or digit and use only letters, digits, "-", and "_"';

/** Report whether one derived id is spelled the way every id space expects. */
export function isValidExtensionId(id: string): boolean {
  return EXTENSION_ID_PATTERN.test(id);
}
