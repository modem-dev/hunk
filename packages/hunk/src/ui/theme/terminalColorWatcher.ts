import type { CliRenderer } from "@opentui/core";
import { ANSI_PALETTE_SIZE, type TerminalColors } from "../../core/theme/terminalColors";

/** Color-scheme change notification a terminal sends after `CSI ? 2031 h` (dark or light). */
const COLOR_SCHEME_NOTIFICATION_PATTERN = /^\x1b\[\?997;[12]n$/;

// Multiplexers write fresh OSC colors and then signal, and terminals can report a scheme change
// before their reloaded palette settles, so collapse bursts into one probe.
const REFRESH_DEBOUNCE_MS = 100;

type PaletteSource = Pick<
  CliRenderer,
  "clearPaletteCache" | "getPalette" | "prependInputHandler" | "removeInputHandler"
>;

interface SignalSource {
  on(event: "SIGWINCH", listener: () => void): unknown;
  removeListener(event: "SIGWINCH", listener: () => void): unknown;
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
  const answered =
    colors.foreground !== undefined ||
    colors.background !== undefined ||
    colors.palette.some((color) => color !== undefined);
  return answered ? colors : undefined;
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

/**
 * Re-probe the terminal's colors whenever something says they may have changed, and report
 * reports that differ from the last one.
 *
 * Two triggers cover how theme switches reach a running Hunk: terminals and multiplexers such as
 * herdr send a mode 2031 color-scheme notification to panes, and tmux has no such notification so
 * theme tooling rewrites each pane's OSC colors and then sends the pane SIGWINCH. SIGWINCH also
 * fires on ordinary resizes; those probes simply find unchanged colors.
 *
 * Startup only probes when the configured theme follows the terminal. When it did not, probe once
 * right away so selecting the `terminal` theme later shows the real palette, not the fallback.
 */
export function watchTerminalColors({
  renderer,
  current,
  onChange,
  signals = process,
}: {
  renderer: PaletteSource;
  current: () => TerminalColors | undefined;
  onChange: (colors: TerminalColors) => void;
  signals?: SignalSource;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const refresh = async () => {
    timer = undefined;
    try {
      // OpenTUI caches the palette and only invalidates it when light/dark flips, which misses
      // a switch between two dark themes.
      renderer.clearPaletteCache();
      const colors = terminalColorsFromPalette(
        await renderer.getPalette({ size: ANSI_PALETTE_SIZE }),
      );
      if (!disposed && colors && !sameTerminalColors(current(), colors)) {
        onChange(colors);
      }
    } catch {
      // A suspended renderer (for example while an editor owns the terminal) cannot probe; the
      // next notification or resize after it resumes will.
    }
  };

  const schedule = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
  };

  const onSequence = (sequence: string) => {
    if (COLOR_SCHEME_NOTIFICATION_PATTERN.test(sequence)) {
      schedule();
    }
    // Leave the notification for OpenTUI, which tracks light/dark from it too.
    return false;
  };

  renderer.prependInputHandler(onSequence);
  signals.on("SIGWINCH", schedule);
  if (current() === undefined) {
    schedule();
  }

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    renderer.removeInputHandler(onSequence);
    signals.removeListener("SIGWINCH", schedule);
  };
}
