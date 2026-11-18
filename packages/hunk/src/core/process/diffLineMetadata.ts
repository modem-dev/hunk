/**
 * Speaks the OSC 1717 diff line metadata protocol, which lets a pager host map rendered rows back
 * to patch lines (https://github.com/stefanhaller/diff-line-metadata-spec).
 *
 * LazyGit stages hunks and lines straight from its diff panel, but only keeps a diff renderer's
 * output while staging when the renderer tags each row with the file, side, and line it shows.
 * The host advertises the versions it understands in the `OSC1717` environment variable; with no
 * shared version Hunk emits nothing, so output outside a participating host is unchanged.
 */

/** The only protocol version Hunk emits. */
const DIFF_LINE_METADATA_VERSION = 1;

/** Record types defined by v1: context, added, deleted, file header, hunk header. */
export type DiffLineMetadataType = "c" | "a" | "d" | "f" | "h";

export interface DiffLineMetadataRecord {
  type: DiffLineMetadataType;
  /** New-file line in the diff's numbering; never set on `f`. */
  newLine?: number;
  /** Old-file line; set only on `d`. */
  oldLine?: number;
  /** Repo-relative path of the file the row belongs to (the new path for renames). */
  path: string;
}

/**
 * Returns the negotiated protocol version, or null when the host shares none.
 *
 * The host lists versions as `V1[,V2,…]`; the list is a set, so order does not matter.
 */
export function negotiateDiffLineMetadataVersion(env: NodeJS.ProcessEnv) {
  const advertised = env.OSC1717?.split(",").map((entry) => entry.trim().toUpperCase()) ?? [];
  return advertised.includes(`V${DIFF_LINE_METADATA_VERSION}`) ? DIFF_LINE_METADATA_VERSION : null;
}

/** Formats the version-only handshake a renderer writes once, before any other output. */
export function formatDiffLineMetadataHandshake() {
  return `\x1b]1717;${DIFF_LINE_METADATA_VERSION}\x1b\\`;
}

/**
 * Formats one per-row record, or returns "" when the path cannot be carried safely.
 *
 * A path with control characters would end the escape sequence early, and the spec prefers no
 * record over a wrong one: an untagged row is merely not actionable in the host.
 */
export function formatDiffLineMetadataRecord(record: DiffLineMetadataRecord) {
  if (!record.path || /[\x00-\x1f\x7f]/.test(record.path)) {
    return "";
  }

  const newLine = record.type === "f" ? "" : String(record.newLine ?? "");
  const oldLine = record.type === "d" ? String(record.oldLine ?? "") : "";
  return `\x1b]1717;${DIFF_LINE_METADATA_VERSION};${record.type};${newLine};${oldLine};${record.path}\x1b\\`;
}
