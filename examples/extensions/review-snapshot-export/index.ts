import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionReviewSnapshot, HunkExtensionAPI } from "hunkdiff/extension";

/** Resolve one user-entered export path without consulting repo-controlled extension config. */
export function resolveSnapshotExportPath(cwd: string, input: string) {
  const trimmed = input.trim();
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

/** Report whether asynchronous work still belongs to the snapshot it started from. */
export function snapshotPositionMatches(
  captured: ExtensionReviewSnapshot,
  current: ExtensionReviewSnapshot | null,
) {
  return (
    current !== null &&
    current.generation === captured.generation &&
    current.stateRevision === captured.stateRevision
  );
}

/** Report whether a filesystem error means the chosen export path already exists. */
function isExistingFileError(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "EEXIST";
}

/** Register a JSON exporter for the authoritative saved-note snapshot. */
export default function registerReviewSnapshotExport(hunk: HunkExtensionAPI) {
  hunk.registerCommand(
    { id: "export", title: "Export review snapshot…", key: "f9" },
    async (ctx) => {
      const captured = ctx.review.snapshot();
      if (!captured) {
        ctx.notify("The current review is unavailable to this command", "warning");
        return;
      }

      const input = await ctx.dialogs.input({
        title: "Export review snapshot",
        placeholder: "hunk-review-snapshot.json",
      });
      if (input === null || input.trim() === "") return;

      // An agent or another surface can change shared review state while this dialog is open.
      // Refuse stale output instead of silently exporting a snapshot the user no longer sees.
      if (!snapshotPositionMatches(captured, ctx.review.snapshot())) {
        ctx.notify("The review changed while exporting; run the command again", "warning");
        return;
      }

      const outputPath = resolveSnapshotExportPath(ctx.cwd, input);
      try {
        await writeFile(outputPath, `${JSON.stringify(captured, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (error) {
        if (isExistingFileError(error)) {
          ctx.notify(`Refusing to overwrite existing file ${outputPath}`, "warning");
          return;
        }
        throw error;
      }
      ctx.notify(
        `Exported ${captured.notes.length} saved ${captured.notes.length === 1 ? "note" : "notes"} to ${outputPath}`,
      );
    },
  );
}
