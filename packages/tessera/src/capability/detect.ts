/**
 * Identifies the host terminal and what it can be trusted to draw.
 *
 * Detection is environment-based and deliberately conservative: an unrecognized
 * terminal reports `unknown` rather than being assumed capable, because a
 * terminal that does not understand a graphics sequence prints its payload as
 * garbage across the screen.
 *
 * A runtime handshake using `encodeSupportQuery` would turn some `unknown`
 * answers into facts, but it needs a raw-mode read with a timeout, which is I/O
 * this module deliberately does not own. Callers that can afford the round trip
 * should run it and override `graphics` on the record returned here.
 */
import { detectMultiplexer, type Multiplexer } from "../protocol/passthrough";

/** Whether the terminal renders the kitty graphics protocol. */
export type GraphicsSupport = "kitty" | "none" | "unknown";

/**
 * How a terminal resamples an image scaled up to fill its cell box.
 *
 * This cannot be discovered at runtime. The protocol neither documents the
 * filter nor exposes a key to select one, and a program cannot read rendered
 * pixels back through the pty, so there is no probe that answers it. The value
 * comes from a table of known implementations and is `unknown` otherwise.
 *
 * It matters because transmitting a reduced-resolution source and letting the
 * terminal enlarge it is the difference between roughly 1K and 10K on the wire
 * for a screenful of chrome. Under `nearest` that trade collapses into visible
 * blocking, so the safe default is to transmit at native resolution.
 */
export type MagnificationFilter = "smooth" | "nearest" | "unknown";

export interface TerminalCapability {
  /** Short identifier for the detected terminal, or "unknown". */
  terminal: string;
  graphics: GraphicsSupport;
  magnification: MagnificationFilter;
  multiplexer: Multiplexer;
  /** True when sequences must be wrapped before the outer terminal sees them. */
  needsPassthrough: boolean;
  /** True when the terminal supports 24-bit color, which placeholder ids require. */
  trueColor: boolean;
}

interface TerminalProfile {
  terminal: string;
  graphics: GraphicsSupport;
  magnification: MagnificationFilter;
  trueColor: boolean;
}

/**
 * What is known about specific terminals.
 *
 * `magnification` is left `unknown` everywhere it has not been confirmed by
 * inspecting rendered output. Guessing here would be worse than not knowing,
 * since the whole point of the field is to gate an optimization that looks
 * broken when the guess is wrong.
 */
const PROFILES: Record<string, TerminalProfile> = {
  kitty: { terminal: "kitty", graphics: "kitty", magnification: "unknown", trueColor: true },
  ghostty: { terminal: "ghostty", graphics: "kitty", magnification: "unknown", trueColor: true },
  wezterm: { terminal: "wezterm", graphics: "kitty", magnification: "unknown", trueColor: true },
  konsole: { terminal: "konsole", graphics: "kitty", magnification: "unknown", trueColor: true },
  iterm2: { terminal: "iterm2", graphics: "unknown", magnification: "unknown", trueColor: true },
  "windows-terminal": {
    terminal: "windows-terminal",
    graphics: "none",
    magnification: "unknown",
    trueColor: true,
  },
  apple: {
    terminal: "apple-terminal",
    graphics: "none",
    magnification: "unknown",
    trueColor: false,
  },
  vscode: { terminal: "vscode", graphics: "none", magnification: "unknown", trueColor: true },
};

/** Matches environment variables to a known terminal profile. */
function identify(env: Record<string, string | undefined>): TerminalProfile | undefined {
  const term = (env.TERM ?? "").toLowerCase();
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();

  if (env.KITTY_WINDOW_ID || term.includes("kitty")) return PROFILES.kitty;
  if (env.GHOSTTY_RESOURCES_DIR || program === "ghostty" || term.includes("ghostty")) {
    return PROFILES.ghostty;
  }
  if (env.WEZTERM_EXECUTABLE || env.WEZTERM_PANE || program === "wezterm") return PROFILES.wezterm;
  if (env.KONSOLE_VERSION) return PROFILES.konsole;
  if (program === "iterm.app") return PROFILES.iterm2;
  if (env.WT_SESSION) return PROFILES["windows-terminal"];
  if (program === "apple_terminal") return PROFILES.apple;
  if (program === "vscode") return PROFILES.vscode;
  return undefined;
}

/** Reports whether the environment advertises 24-bit color. */
function hasTrueColor(env: Record<string, string | undefined>): boolean {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  return colorterm === "truecolor" || colorterm === "24bit";
}

/**
 * Builds a capability record from the environment.
 *
 * A multiplexer downgrades graphics support to `unknown` even for a terminal
 * known to be capable, because whether passthrough is permitted is a runtime
 * configuration question the environment does not answer.
 */
export function detectCapability(
  env: Record<string, string | undefined> = process.env,
): TerminalCapability {
  const profile = identify(env);
  const multiplexer = detectMultiplexer(env);
  const base: TerminalProfile = profile ?? {
    terminal: "unknown",
    graphics: "unknown",
    magnification: "unknown",
    trueColor: false,
  };

  return {
    terminal: base.terminal,
    graphics: multiplexer === "none" ? base.graphics : downgrade(base.graphics),
    magnification: base.magnification,
    multiplexer,
    needsPassthrough: multiplexer !== "none",
    trueColor: base.trueColor || hasTrueColor(env),
  };
}

/** Softens a confident "kitty" into "unknown" when something sits in the middle. */
function downgrade(support: GraphicsSupport): GraphicsSupport {
  return support === "kitty" ? "unknown" : support;
}

/**
 * Chooses how far to reduce a source image below its native pixel size.
 *
 * Returns a divisor: 1 transmits at native resolution. Reduction is only
 * offered when the terminal is known to resample smoothly, since under a
 * nearest-neighbour magnifier a reduced source is plainly worse than the text
 * fallback it was meant to beat.
 */
export function chooseSourceScale(capability: TerminalCapability, preferred = 4): number {
  if (capability.magnification !== "smooth") return 1;
  return Math.max(1, Math.floor(preferred));
}
