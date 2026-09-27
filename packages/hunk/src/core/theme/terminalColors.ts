/** Id of the built-in theme drawn from the terminal's own colors, and Hunk's default theme. */
export const TERMINAL_THEME_ID = "terminal";

/**
 * Return whether a requested theme id depends on what the terminal looks like: the default
 * (no id), the terminal-colors theme itself, and `auto` light/dark selection.
 */
export function themeFollowsTerminal(themeId: string | undefined) {
  return themeId === undefined || themeId === TERMINAL_THEME_ID || themeId === "auto";
}

/**
 * The colors the controlling terminal reports for its default foreground, background, and
 * 16-color ANSI palette, as #rrggbb. Any slot the terminal did not answer stays undefined.
 */
export interface TerminalColors {
  foreground?: string;
  background?: string;
  palette: (string | undefined)[];
}

/** ANSI palette slots in the order terminals number them. */
export const ANSI_COLOR_INDEX = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  brightBlack: 8,
  brightRed: 9,
  brightGreen: 10,
  brightYellow: 11,
  brightBlue: 12,
  brightMagenta: 13,
  brightCyan: 14,
  brightWhite: 15,
} as const;

export const ANSI_PALETTE_SIZE = 16;

/**
 * Stand-in palettes for terminals that never answer color queries, such as piped static output
 * or a terminal without OSC 4 support. These follow the common xterm/VTE defaults.
 */
export const FALLBACK_TERMINAL_COLORS = {
  dark: {
    foreground: "#d0d0d0",
    background: "#000000",
    palette: [
      "#000000",
      "#cd3131",
      "#0dbc79",
      "#e5e510",
      "#2472c8",
      "#bc3fbc",
      "#11a8cd",
      "#e5e5e5",
      "#666666",
      "#f14c4c",
      "#23d18b",
      "#f5f543",
      "#3b8eea",
      "#d670d6",
      "#29b8db",
      "#ffffff",
    ],
  },
  light: {
    foreground: "#000000",
    background: "#ffffff",
    palette: [
      "#000000",
      "#cd3131",
      "#00bc00",
      "#949800",
      "#0451a5",
      "#bc05bc",
      "#0598bc",
      "#555555",
      "#666666",
      "#cd3131",
      "#14ce14",
      "#b5ba00",
      "#0451a5",
      "#bc05bc",
      "#0598bc",
      "#a5a5a5",
    ],
  },
} as const satisfies Record<"dark" | "light", Required<TerminalColors>>;

let detectedTerminalColors: TerminalColors | undefined;

/**
 * Record what the controlling terminal reported during startup. One process drives one
 * terminal, so every surface that derives the `terminal` theme reads this same answer.
 */
export function setDetectedTerminalColors(colors: TerminalColors | undefined) {
  detectedTerminalColors = colors;
}

/** Return the colors the controlling terminal reported, when startup probed them. */
export function getDetectedTerminalColors() {
  return detectedTerminalColors;
}
