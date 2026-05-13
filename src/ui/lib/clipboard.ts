import { spawnSync as spawnClipboardCommand } from "node:child_process";

export interface TerminalClipboard {
  copyToClipboardOSC52: (text: string) => boolean;
}

interface RendererSelection {
  getSelectedText: () => string;
}

export interface SelectionRenderer extends TerminalClipboard {
  getSelection: () => RendererSelection | null | undefined;
}

type SpawnClipboardCommand = (
  command: string,
  args: string[],
  options: { input: string; stdio: ["pipe", "ignore", "ignore"] },
) => { status: number | null };

interface ClipboardDeps {
  platform?: NodeJS.Platform;
  spawnSync?: SpawnClipboardCommand;
}

export type YankResult = "copied" | "no-selection" | "unavailable";

/** Copy text to the clipboard, preferring macOS pbcopy over terminal OSC52 locally. */
export function copyTextToClipboard(
  text: string,
  terminal: TerminalClipboard,
  { platform = process.platform, spawnSync = spawnClipboardCommand }: ClipboardDeps = {},
) {
  if (platform === "darwin") {
    try {
      const result = spawnSync("pbcopy", [], {
        input: text,
        stdio: ["pipe", "ignore", "ignore"],
      });
      if (result.status === 0) {
        return true;
      }
    } catch {
      // Fall through to OSC52 for remote or restricted environments.
    }
  }

  return terminal.copyToClipboardOSC52(text);
}

/** Read the active terminal selection and copy it; report why if nothing reached the clipboard. */
export function yankActiveSelection(renderer: SelectionRenderer, deps?: ClipboardDeps): YankResult {
  const text = renderer.getSelection()?.getSelectedText() ?? "";
  if (text.length === 0) {
    return "no-selection";
  }
  return copyTextToClipboard(text, renderer, deps) ? "copied" : "unavailable";
}
