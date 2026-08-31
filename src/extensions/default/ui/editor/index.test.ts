import { describe, expect, mock, test } from "bun:test";
import type { ExtensionCommandContext } from "hunkdiff/extension";
import { getBundledUIRegistry } from "..";
import { BUNDLED_EDITOR_COMMAND_FULL_ID } from ".";

/** Return the editor registration from the process-static bundled UI registry. */
function getBundledEditorCommand() {
  const registered = getBundledUIRegistry().commands.find(
    ({ extensionId, command }) => `${extensionId}.${command.id}` === BUNDLED_EDITOR_COMMAND_FULL_ID,
  );
  if (!registered) throw new Error("Bundled editor command is missing.");
  return registered;
}

describe("bundled editor extension", () => {
  test("registers the shared Hunk command identity without owning its host key shell", () => {
    const registered = getBundledEditorCommand();

    expect(registered.extensionId).toBe("hunk");
    expect(registered.command).toEqual({
      id: "review.editSelectedFile",
      title: "Open the selected file in your editor",
    });
  });

  test("forwards the frozen review selection to the host editor capability", async () => {
    const openInEditor = mock(async () => ({ ok: true as const }));
    const notify = mock(() => {});
    const context = {
      notify,
      selection: {
        file: { id: "alpha" },
        hunkIndex: 2,
        currentLine: { side: "old", line: 17 },
      },
      workspace: { openInEditor },
    } as unknown as ExtensionCommandContext;

    await getBundledEditorCommand().handler(context);

    expect(openInEditor).toHaveBeenCalledWith({
      fileId: "alpha",
      hunkIndex: 2,
      line: { side: "old", line: 17 },
    });
    expect(notify).not.toHaveBeenCalled();
  });

  test("surfaces host refusals without attempting its own process or path handling", async () => {
    const notify = mock(() => {});
    const context = {
      notify,
      selection: { file: { id: "alpha" }, hunkIndex: null, currentLine: null },
      workspace: {
        openInEditor: async () => ({
          ok: false as const,
          reason: "unavailable" as const,
          detail: "$EDITOR is not set.",
        }),
      },
    } as unknown as ExtensionCommandContext;

    await getBundledEditorCommand().handler(context);

    expect(notify).toHaveBeenCalledWith("$EDITOR is not set.", "warning");
  });
});
