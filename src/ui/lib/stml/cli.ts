// Runners for `hunk markup render` and `hunk markup guide`. Kept out of
// main.tsx so the command behavior is directly testable.

import { resolve as resolvePath } from "node:path";
import type { MarkupRenderCommandInput } from "../../../core/types";
import { resolveTheme } from "../../themes";
import { STML_GUIDE } from "./guide";
import { renderStmlToAnsi, renderStmlToText } from "./render";

export interface MarkupCommandIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdoutIsTTY: boolean;
  readStdinText: () => Promise<string>;
}

const DEFAULT_PREVIEW_THEME = "github-dark-default";

/** Execute `hunk markup render`; returns the process exit code. */
export async function runMarkupRenderCommand(
  input: MarkupRenderCommandInput,
  io: MarkupCommandIo,
): Promise<number> {
  const markup =
    input.file === "-"
      ? await io.readStdinText()
      : await Bun.file(resolvePath(process.cwd(), input.file)).text();

  const useColor =
    input.color === "always" || (input.color === "auto" && io.stdoutIsTTY && !input.json);

  const result = useColor
    ? renderStmlToAnsi(
        markup,
        input.width,
        resolveTheme(input.theme ?? DEFAULT_PREVIEW_THEME, null),
      )
    : renderStmlToText(markup, input.width);

  if (input.json) {
    io.stdout(
      `${JSON.stringify({ width: input.width, lines: result.lines, notes: result.errors }, null, 2)}\n`,
    );
    return 0;
  }

  io.stdout(`${result.lines.join("\n")}\n`);
  for (const note of result.errors) {
    io.stderr(`note: ${note}\n`);
  }
  return 0;
}

/** Execute `hunk markup guide`. */
export function runMarkupGuideCommand(io: Pick<MarkupCommandIo, "stdout">): number {
  io.stdout(STML_GUIDE);
  return 0;
}
