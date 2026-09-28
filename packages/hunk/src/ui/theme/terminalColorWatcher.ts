import { type CliRenderer, RendererControlState } from "@opentui/core";
import {
  DEVICE_ATTRIBUTES_QUERY,
  hasTerminalColors,
  isDeviceAttributesReply,
  parseTerminalColorReplies,
  TERMINAL_COLOR_QUERY,
} from "../../core/theme/detection";
import { ANSI_PALETTE_SIZE, type TerminalColors } from "../../core/theme/terminalColors";

/** Color-scheme change notification a terminal sends after `CSI ? 2031 h` (dark or light). */
const COLOR_SCHEME_NOTIFICATION_PATTERN = /^\x1b\[\?997;[12]n$/;

// Multiplexers write fresh OSC colors and then signal, and terminals can report a scheme change
// before their reloaded palette settles, so collapse bursts into one probe.
const REFRESH_DEBOUNCE_MS = 100;
// The DA1 fence ends a probe as soon as a responsive terminal has answered, so this only bounds
// terminals that skip some color queries or answer over a very slow link.
const PROBE_TIMEOUT_MS = 1500;
// How long an unanswered DA1 fence holds back the next probe. Past this, a very late DA1 could
// close a newer probe early, which only costs that probe some colors.
const FENCE_EXPIRY_MS = 5000;
// OpenTUI 0.5.6 writes its own DA1 only from `setupTerminal()` (including a DCS-wrapped retry for
// tmux once XTVERSION answers) and stops listening for capability replies 5 s later. The renderer
// is set up before Hunk mounts, so for this long after mounting a DA1 reply may be OpenTUI's.
const STARTUP_CAPABILITY_WINDOW_MS = 5000;

type TerminalColorSource = Pick<
  CliRenderer,
  | "clearPaletteCache"
  | "controlState"
  | "getPalette"
  | "isDestroyed"
  | "prependInputHandler"
  | "removeInputHandler"
  | "subscribeOsc"
> & {
  on(event: "theme_mode", listener: () => void): unknown;
  off(event: "theme_mode", listener: () => void): unknown;
};

interface SignalSource {
  on(event: "SIGWINCH", listener: () => void): unknown;
  removeListener(event: "SIGWINCH", listener: () => void): unknown;
}

/**
 * Return a writer that sends raw bytes through the renderer's frame-ordered output, or undefined
 * when this OpenTUI build does not have one.
 *
 * OpenTUI 0.5.6 declares `writeOut` private, but it is the path its own palette detector uses:
 * on the threaded renderer it waits for an in-progress frame, so a query never lands inside one,
 * which a direct `stdout.write` does not guarantee. OpenTUI has no public raw-write API yet, so
 * the cast stays here and callers fall back to `getPalette()` if an upgrade removes it.
 */
export function rendererRawWriter(renderer: object): ((data: string) => void) | undefined {
  const writeOut = (renderer as { writeOut?: unknown }).writeOut;
  if (typeof writeOut !== "function") return undefined;
  return (data) => {
    writeOut.call(renderer, data);
  };
}

/** Convert OpenTUI's palette report into Hunk's terminal colors, or undefined when it is empty. */
export function terminalColorsFromPalette(report: {
  palette: (string | null)[];
  defaultForeground: string | null;
  defaultBackground: string | null;
}): TerminalColors | undefined {
  const colors: TerminalColors = {
    foreground: report.defaultForeground ?? undefined,
    background: report.defaultBackground ?? undefined,
    palette: report.palette.slice(0, ANSI_PALETTE_SIZE).map((color) => color ?? undefined),
  };
  return hasTerminalColors(colors) ? colors : undefined;
}

/** Return whether two terminal color reports describe the same colors. */
export function sameTerminalColors(left: TerminalColors | undefined, right: TerminalColors) {
  return (
    left !== undefined &&
    left.foreground === right.foreground &&
    left.background === right.background &&
    Array.from({ length: ANSI_PALETTE_SIZE }).every(
      (_, index) => left.palette[index] === right.palette[index],
    )
  );
}

/** Copy every slot one parsed reply answered into the colors collected so far. */
function mergeTerminalColors(into: TerminalColors, reply: TerminalColors) {
  if (reply.foreground !== undefined) into.foreground = reply.foreground;
  if (reply.background !== undefined) into.background = reply.background;
  reply.palette.forEach((color, index) => {
    if (color !== undefined) into.palette[index] = color;
  });
}

/** Return whether a probe has an answer for every color it asked about. */
function answeredEveryColorQuery(colors: TerminalColors) {
  return (
    colors.foreground !== undefined &&
    colors.background !== undefined &&
    Array.from({ length: ANSI_PALETTE_SIZE }).every(
      (_, index) => colors.palette[index] !== undefined,
    )
  );
}

interface Probe {
  /** A newer trigger arrived after this probe was written, so its answer may predate the change. */
  stale: boolean;
  /** Finish with whatever the terminal has answered so far. */
  close(): void;
}

/**
 * Re-probe the terminal's colors whenever something says they may have changed, and report
 * reports that differ from the last one.
 *
 * Three triggers cover how theme switches reach a running Hunk: terminals and multiplexers such as
 * herdr send a mode 2031 color-scheme notification to panes; tmux has no such notification, so
 * theme tooling rewrites each pane's OSC colors and then sends the pane SIGWINCH; and OpenTUI's own
 * `theme_mode` event fires when it learns light/dark after Hunk's startup probe came up empty.
 * SIGWINCH also fires on ordinary resizes; those probes simply find unchanged colors.
 *
 * Each probe writes Hunk's startup color query plus a DA1 fence through the renderer and collects
 * the OSC replies OpenTUI parses, so it finishes as soon as the terminal has answered instead of
 * waiting out OpenTUI's palette idle timeout. Probes never overlap on the wire: a trigger while a
 * probe is in flight discards that probe's answer and queues one fresh probe, and the next probe
 * waits until the previous DA1 fence is answered, so replies owed to older queries cannot mix
 * into it. The watcher consumes only DA1 replies it is owed, leaving the rest to OpenTUI. Until
 * OpenTUI's startup capability window closes, a DA1 reply may be OpenTUI's own, so probes there
 * skip the fence and finish once every color is answered or on the timeout. Without a raw
 * writer, probes fall back to OpenTUI's slower `getPalette()`.
 *
 * Startup only probes when the configured theme follows the terminal. When it did not, probe once
 * right away so selecting the `terminal` theme later shows the real palette, not the fallback.
 */
export function watchTerminalColors({
  renderer,
  current,
  onChange,
  signals = process,
  write = rendererRawWriter(renderer),
  debounceMs = REFRESH_DEBOUNCE_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  fenceExpiryMs = FENCE_EXPIRY_MS,
  startupCapabilityWindowMs = STARTUP_CAPABILITY_WINDOW_MS,
}: {
  renderer: TerminalColorSource;
  current: () => TerminalColors | undefined;
  onChange: (colors: TerminalColors) => void;
  signals?: SignalSource;
  /** Raw terminal writer; without one the watcher falls back to OpenTUI's `getPalette()`. */
  write?: (data: string) => void;
  debounceMs?: number;
  probeTimeoutMs?: number;
  fenceExpiryMs?: number;
  startupCapabilityWindowMs?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let probe: Probe | undefined;
  let probeRequested = false;
  // At most one DA1 fence of ours is ever unanswered; its expiry timer doubles as the flag.
  let owedFence: ReturnType<typeof setTimeout> | undefined;
  let fencesActive = startupCapabilityWindowMs <= 0;
  const fenceWindow = fencesActive
    ? undefined
    : setTimeout(() => {
        fencesActive = true;
      }, startupCapabilityWindowMs);

  const apply = (colors: TerminalColors | undefined) => {
    if (!disposed && colors && !sameTerminalColors(current(), colors)) onChange(colors);
  };

  /** Start the next requested probe once nothing is in flight or owed on the wire. */
  const drain = () => {
    if (disposed || !probeRequested || probe || owedFence) return;
    probeRequested = false;
    startProbe();
  };

  const settleFence = () => {
    if (owedFence) clearTimeout(owedFence);
    owedFence = undefined;
  };

  const startProbe = () => {
    // A suspended renderer (for example while an editor owns the terminal) must not write queries
    // and drops input anyway; the next notification or resize after it resumes will probe.
    if (renderer.isDestroyed || renderer.controlState === RendererControlState.EXPLICIT_SUSPENDED) {
      return;
    }

    let deadline: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const collected: TerminalColors = { palette: [] };
    const finish = (colors: TerminalColors | undefined) => {
      if (probe !== self) return;
      probe = undefined;
      if (deadline) clearTimeout(deadline);
      unsubscribe?.();
      if (!self.stale) apply(colors);
      drain();
    };
    const self: Probe = {
      stale: false,
      close: () => finish(hasTerminalColors(collected) ? collected : undefined),
    };
    probe = self;

    if (!write) {
      // OpenTUI caches the palette and only invalidates it when light/dark flips, which misses a
      // switch between two dark themes.
      renderer.clearPaletteCache();
      renderer.getPalette({ size: ANSI_PALETTE_SIZE }).then(
        (report) => finish(terminalColorsFromPalette(report)),
        // A renderer that suspends mid-probe cannot answer; the next trigger after resume will.
        () => finish(undefined),
      );
      return;
    }

    unsubscribe = renderer.subscribeOsc((sequence) => {
      mergeTerminalColors(collected, parseTerminalColorReplies(sequence));
      if (answeredEveryColorQuery(collected)) self.close();
    });
    deadline = setTimeout(self.close, probeTimeoutMs);

    // During OpenTUI's startup capability window a DA1 reply may be OpenTUI's own, so probes there
    // skip the fence and finish once every color is answered or on the timeout.
    const fenced = fencesActive;
    try {
      write(fenced ? `${TERMINAL_COLOR_QUERY}${DEVICE_ATTRIBUTES_QUERY}` : TERMINAL_COLOR_QUERY);
    } catch {
      finish(undefined);
      return;
    }
    if (fenced) {
      // A probe that times out keeps its fence owed, so a late DA1 cannot close the next probe.
      owedFence = setTimeout(() => {
        owedFence = undefined;
        drain();
      }, fenceExpiryMs);
    }
  };

  const requestProbe = () => {
    timer = undefined;
    probeRequested = true;
    drain();
  };

  /** Debounce a probe; a real change also marks any in-flight probe's answer as outdated. */
  const schedule = () => {
    if (disposed) return;
    if (probe) probe.stale = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(requestProbe, debounceMs);
  };

  const onSequence = (sequence: string) => {
    if (COLOR_SCHEME_NOTIFICATION_PATTERN.test(sequence)) {
      schedule();
      // Leave the notification for OpenTUI, which tracks light/dark from it too.
      return false;
    }
    if (owedFence && isDeviceAttributesReply(sequence)) {
      settleFence();
      probe?.close();
      drain();
      // OpenTUI re-parses every DA1 as a capability reply and forces a full repaint, so swallow
      // the fences it never asked for.
      return true;
    }
    return false;
  };

  // OpenTUI reports light/dark from its own OSC 10/11 query, answered before any probe of ours
  // that the same change triggered, so it only asks for a probe and never invalidates one.
  const onThemeMode = () => {
    if (!timer && !probe && !probeRequested) schedule();
  };

  // OSC replies reach subscribers before input handlers, and handlers never see a probe's colors
  // as keys, so the watcher only needs to intercept notifications and its own fences.
  renderer.prependInputHandler(onSequence);
  renderer.on("theme_mode", onThemeMode);
  signals.on("SIGWINCH", schedule);
  if (current() === undefined) {
    schedule();
  }

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    if (fenceWindow) clearTimeout(fenceWindow);
    probe?.close();
    settleFence();
    renderer.removeInputHandler(onSequence);
    renderer.off("theme_mode", onThemeMode);
    signals.removeListener("SIGWINCH", schedule);
  };
}
