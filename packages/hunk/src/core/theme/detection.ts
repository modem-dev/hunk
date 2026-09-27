import { ANSI_PALETTE_SIZE, type TerminalColors } from "./terminalColors";

/**
 * Which of the two terminal backgrounds a session is drawn against. Probing the
 * terminal answers it here; the app carries the answer into theme selection.
 */
export type TerminalThemeMode = "light" | "dark";

export interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

interface ThemeProbeInput {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
  setRawMode?(mode: boolean): unknown;
  isRaw?: boolean;
}

interface ThemeProbeOutput {
  write(chunk: string): unknown;
}

export interface DetectTerminalThemeOptions {
  input: ThemeProbeInput;
  output: ThemeProbeOutput;
  timeoutMs?: number;
}

const OSC_TERMINATOR = "(?:\\x07|\\x1b\\\\)";
const OSC_COLOR_SPEC = "(rgb:[0-9a-f]{1,4}/[0-9a-f]{1,4}/[0-9a-f]{1,4}|#[0-9a-f]{6})";
const OSC_COLOR_REPLY_PATTERN = new RegExp(
  `\\x1b\\](?:4;(\\d+)|(10)|(11));${OSC_COLOR_SPEC}${OSC_TERMINATOR}`,
  "gi",
);
// Terminals answer queries in order, so the primary device attributes reply marks the point where
// every color reply the terminal was ever going to send has already arrived.
const DEVICE_ATTRIBUTES_QUERY = "\x1b[c";
const DEVICE_ATTRIBUTES_REPLY_PATTERN = /\x1b\[\?[\d;]*c/;

/** Convert xterm-style OSC color channels into 8-bit RGB. */
function parseHexChannel(channel: string) {
  const value = Number.parseInt(channel, 16);
  if (Number.isNaN(value)) {
    return null;
  }

  const max = 16 ** channel.length - 1;
  return Math.round((value / max) * 255);
}

/** Parse one OSC color spec such as `rgb:ffff/8080/0000` or `#ff8000` into RGB. */
function parseOscColorSpec(spec: string): RgbColor | null {
  if (spec.startsWith("#")) {
    return {
      red: Number.parseInt(spec.slice(1, 3), 16),
      green: Number.parseInt(spec.slice(3, 5), 16),
      blue: Number.parseInt(spec.slice(5, 7), 16),
    };
  }

  const [red, green, blue] = spec.slice("rgb:".length).split("/").map(parseHexChannel);
  return red == null || green == null || blue == null ? null : { red, green, blue };
}

/** Format RGB as the #rrggbb strings Hunk themes use. */
function rgbToHex({ red, green, blue }: RgbColor) {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Parse common OSC 11 background-color responses into RGB. */
export function parseOsc11BackgroundColor(sequence: string): RgbColor | null {
  const background = parseTerminalColorReplies(sequence).background;
  return background ? parseOscColorSpec(background) : null;
}

/** Collect every OSC 4 (palette), OSC 10 (foreground), and OSC 11 (background) reply. */
export function parseTerminalColorReplies(sequence: string): TerminalColors {
  const colors: TerminalColors = { palette: [] };
  for (const match of sequence.matchAll(OSC_COLOR_REPLY_PATTERN)) {
    const [, paletteIndex, foreground, background, spec] = match;
    const rgb = parseOscColorSpec(spec!);
    if (!rgb) {
      continue;
    }

    const hex = rgbToHex(rgb);
    if (foreground) {
      colors.foreground = hex;
    } else if (background) {
      colors.background = hex;
    } else {
      const index = Number(paletteIndex);
      if (index < ANSI_PALETTE_SIZE) {
        colors.palette[index] = hex;
      }
    }
  }

  return colors;
}

/** Classify a background color using relative luminance. */
export function themeModeForBackgroundColor({ red, green, blue }: RgbColor): TerminalThemeMode {
  const linear = [red, green, blue].map((component) => {
    const normalized = component / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  return luminance > 0.5 ? "light" : "dark";
}

/** Classify probed terminal colors by their reported background, when there is one. */
export function themeModeForTerminalColors(colors: TerminalColors | null | undefined) {
  const background = colors?.background ? parseOscColorSpec(colors.background) : null;
  return background ? themeModeForBackgroundColor(background) : undefined;
}

/** Return whether a probe learned anything at all about the terminal's colors. */
function hasTerminalColors(colors: TerminalColors) {
  return (
    colors.foreground !== undefined ||
    colors.background !== undefined ||
    colors.palette.some((color) => color !== undefined)
  );
}

/**
 * Probe the terminal foreground, background, and 16-color palette via OSC 10/11/4 using the same
 * input stream OpenTUI uses for mouse. This avoids treating piped diff stdin as terminal input
 * while leaving renderer stdout unchanged.
 */
export async function detectTerminalColors({
  input,
  output,
  timeoutMs = 150,
}: DetectTerminalThemeOptions): Promise<TerminalColors | null> {
  const wasRaw = input.isRaw;
  let settled = false;
  let buffer = "";

  return await new Promise<TerminalColors | null>((resolve) => {
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.removeListener("data", onData);
      if (wasRaw !== undefined) {
        input.setRawMode?.(wasRaw);
      }

      const colors = parseTerminalColorReplies(buffer);
      resolve(hasTerminalColors(colors) ? colors : null);
    };

    const timer = setTimeout(finish, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (DEVICE_ATTRIBUTES_REPLY_PATTERN.test(buffer)) {
        finish();
      }
    };

    input.setRawMode?.(true);
    input.resume?.();
    input.on("data", onData);

    const paletteQueries = Array.from(
      { length: ANSI_PALETTE_SIZE },
      (_, index) => `\x1b]4;${index};?\x1b\\`,
    ).join("");
    output.write(`\x1b]10;?\x1b\\\x1b]11;?\x1b\\${paletteQueries}${DEVICE_ATTRIBUTES_QUERY}`);
  });
}
