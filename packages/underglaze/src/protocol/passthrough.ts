/**
 * Wraps escape sequences so they survive a terminal multiplexer.
 *
 * tmux and screen consume APC sequences they do not recognize, which silently
 * swallows graphics commands. Both offer a passthrough envelope that hands the
 * payload to the outer terminal untouched, at the cost of escaping and, for
 * screen, splitting into short pieces.
 *
 * Passthrough only helps when the outer terminal speaks the protocol and the
 * multiplexer is configured to allow it (tmux needs `allow-passthrough on`).
 */

const ESC = String.fromCharCode(0x1b);
const DCS = `${ESC}P`;
const ST = ESC + String.fromCharCode(0x5c);

/** Which multiplexer, if any, sits between the process and the terminal. */
export type Multiplexer = "none" | "tmux" | "screen";

/** Longest payload screen accepts in one DCS envelope. */
const SCREEN_CHUNK = 768;

/**
 * Wraps a sequence for tmux by doubling every ESC and enclosing it in a DCS.
 *
 * tmux strips one level of escaping as it forwards, so the doubling is what
 * makes the inner sequence arrive intact.
 */
export function wrapTmux(sequence: string): string {
  return `${DCS}tmux;${sequence.split(ESC).join(ESC + ESC)}${ST}`;
}

/**
 * Wraps a sequence for screen, splitting it across envelopes when needed.
 *
 * screen truncates long DCS payloads, so anything past its limit has to be
 * re-enveloped rather than sent as one piece.
 */
export function wrapScreen(sequence: string): string {
  const parts: string[] = [];
  for (let i = 0; i < sequence.length; i += SCREEN_CHUNK) {
    parts.push(DCS + sequence.slice(i, i + SCREEN_CHUNK) + ST);
  }
  return parts.join("");
}

/** Applies the envelope the given multiplexer requires, if any. */
export function wrapForMultiplexer(sequence: string, multiplexer: Multiplexer): string {
  switch (multiplexer) {
    case "tmux":
      return wrapTmux(sequence);
    case "screen":
      return wrapScreen(sequence);
    case "none":
      return sequence;
  }
}

/**
 * Detects the multiplexer from environment variables.
 *
 * Only the session variables count as evidence. `TERM=screen-256color` is set by
 * plenty of things that are not screen (tmux itself, among others), so it is not
 * treated as a signal on its own.
 */
export function detectMultiplexer(env: Record<string, string | undefined>): Multiplexer {
  if (env.TMUX) return "tmux";
  if (env.STY) return "screen";
  return "none";
}
