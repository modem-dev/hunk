import type { TerminalThemeMode } from "./types";

export type { TerminalThemeMode } from "./types";

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

const OSC_11_BACKGROUND_QUERY = "\x1b]11;?\x1b\\";

/** Convert xterm-style OSC 11 color channels into 8-bit RGB. */
function parseHexChannel(channel: string) {
  const value = Number.parseInt(channel, 16);
  if (Number.isNaN(value)) {
    return null;
  }

  const max = 16 ** channel.length - 1;
  return Math.round((value / max) * 255);
}

/** Parse common OSC 11 background-color responses into RGB. */
export function parseOsc11BackgroundColor(sequence: string): RgbColor | null {
  const rgbMatch =
    /\x1b\]11;rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})(?:\x07|\x1b\\)/i.exec(sequence);
  if (rgbMatch) {
    const red = parseHexChannel(rgbMatch[1]!);
    const green = parseHexChannel(rgbMatch[2]!);
    const blue = parseHexChannel(rgbMatch[3]!);
    return red === null || green === null || blue === null ? null : { red, green, blue };
  }

  const hexMatch = /\x1b\]11;#([0-9a-f]{6})(?:\x07|\x1b\\)/i.exec(sequence);
  if (!hexMatch) {
    return null;
  }

  const [, hex] = hexMatch;
  return {
    red: Number.parseInt(hex!.slice(0, 2), 16),
    green: Number.parseInt(hex!.slice(2, 4), 16),
    blue: Number.parseInt(hex!.slice(4, 6), 16),
  };
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

/**
 * Probe the terminal background via OSC 11 using the same input stream OpenTUI uses for mouse.
 * This avoids treating piped diff stdin as terminal input while leaving renderer stdout unchanged.
 */
export async function detectTerminalThemeModeFromBackground({
  input,
  output,
  timeoutMs = 150,
}: DetectTerminalThemeOptions): Promise<TerminalThemeMode | null> {
  const wasRaw = input.isRaw;
  let settled = false;
  let buffer = "";

  return await new Promise<TerminalThemeMode | null>((resolve) => {
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.removeListener("data", onData);
      if (wasRaw !== undefined) {
        input.setRawMode?.(wasRaw);
      }
    };

    const finish = (mode: TerminalThemeMode | null) => {
      cleanup();
      resolve(mode);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    const onData = (chunk: Buffer | string) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      const color = parseOsc11BackgroundColor(buffer);
      if (color) {
        finish(themeModeForBackgroundColor(color));
      }
    };

    input.setRawMode?.(true);
    input.resume?.();
    input.on("data", onData);
    output.write(OSC_11_BACKGROUND_QUERY);
  });
}
