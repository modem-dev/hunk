import { createHash } from "node:crypto";
import { Terminal as XtermHeadless } from "@xterm/headless";
import { PersistentTerminal, hasPersistentTerminalSupport } from "ghostty-opentui";
import { WATCH_TERMINAL_GEOMETRY } from "./schema";

export interface TerminalClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultClock: TerminalClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface VisibleScreenMarker {
  menu: "File  View";
  requiredText: string[];
}

export interface WatchTerminalLaunchOptions {
  executablePath: string;
  cwd: string;
  env: Record<string, string | undefined>;
  marker: VisibleScreenMarker;
  timeoutMs: number;
  clock?: TerminalClock;
}

export interface WatchTerminalLaunchResult {
  session: WatchTerminalSession;
  launchToMarkerMs: number;
  screenText: string;
}

/** Report the emulator selected on this host for raw provenance. */
export function terminalScreenParser(): "ghostty-opentui" | "xterm-headless-fallback" {
  return hasPersistentTerminalSupport() ? "ghostty-opentui" : "xterm-headless-fallback";
}

/** Hold PTY bytes in one terminal-emulated screen on every supported host. */
export class EmulatedTerminalScreen {
  private readonly persistent: PersistentTerminal | null;
  private readonly xterm: XtermHeadless | null;
  private readonly chunks: Uint8Array[] = [];
  readonly parser: "ghostty-opentui" | "xterm-headless-fallback";

  constructor(options: { forceFallback?: boolean } = {}) {
    this.persistent =
      hasPersistentTerminalSupport() && !options.forceFallback
        ? new PersistentTerminal({
            cols: WATCH_TERMINAL_GEOMETRY.columns,
            rows: WATCH_TERMINAL_GEOMETRY.rows,
          })
        : null;
    this.xterm = this.persistent
      ? null
      : new XtermHeadless({
          cols: WATCH_TERMINAL_GEOMETRY.columns,
          rows: WATCH_TERMINAL_GEOMETRY.rows,
          allowProposedApi: true,
          scrollback: 0,
        });
    this.parser = this.persistent ? "ghostty-opentui" : "xterm-headless-fallback";
  }

  /** Feed one complete PTY byte chunk without assuming UTF-8 or escape-sequence boundaries. */
  feed(bytes: Uint8Array, onParsed?: () => void): void {
    const copy = Uint8Array.from(bytes);
    this.chunks.push(copy);
    if (this.persistent) {
      this.persistent.feed(copy);
      onParsed?.();
    } else {
      this.xterm!.write(copy, onParsed);
    }
  }

  /** Return the terminal emulator's current visible text rather than stripped raw history. */
  getText(): string {
    if (this.persistent) return this.persistent.getText();
    const buffer = this.xterm!.buffer.active;
    return Array.from(
      { length: WATCH_TERMINAL_GEOMETRY.rows },
      (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
    ).join("\n");
  }

  /** Require the top-row menu and fixture-specific title or content on the same screen. */
  hasMarker(marker: VisibleScreenMarker): boolean {
    const text = this.getText();
    const firstVisibleLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
    return (
      firstVisibleLine.includes(marker.menu) &&
      marker.requiredText.every((part) => text.includes(part))
    );
  }

  /** Return all captured bytes for failed-run diagnostics and parser fixtures. */
  getRawBytes(): Uint8Array {
    return Buffer.concat(this.chunks.map((chunk) => Buffer.from(chunk)));
  }

  /** Release the native Ghostty parser when persistent mode is available. */
  close(): void {
    this.persistent?.destroy();
    this.xterm?.dispose();
  }
}

/** Wait for one condition while preserving timeout cleanup and early process exits. */
export function waitForTerminalCondition(options: {
  subscribe: (notify: () => void) => () => void;
  condition: () => boolean;
  processExited: () => boolean;
  timeoutMs: number;
  clock: TerminalClock;
  timeoutMessage: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      options.clock.clearTimeout(timeout);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (options.condition()) finish();
      else if (options.processExited())
        finish(new Error("Watch process exited before the screen marker appeared"));
    };
    const unsubscribe = options.subscribe(check);
    const timeout = options.clock.setTimeout(
      () =>
        finish(Object.assign(new Error(options.timeoutMessage), { code: "HUNK_BENCH_TIMEOUT" })),
      options.timeoutMs,
    );
    check();
  });
}

/** Own one compiled Hunk process, its Bun.Terminal, emulated screen, and deterministic cleanup. */
export class WatchTerminalSession {
  private readonly listeners = new Set<() => void>();
  private cleanupPromise: Promise<boolean> | null = null;

  constructor(
    readonly process: Bun.Subprocess,
    readonly terminal: Bun.Terminal,
    readonly screen: EmulatedTerminalScreen,
    readonly clock: TerminalClock,
  ) {
    void process.exited.finally(() => this.notify());
  }

  /** Notify screen waiters after a PTY update or process exit. */
  notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Wait until the complete menu and fixture marker are present on the emulated screen. */
  async waitForMarker(marker: VisibleScreenMarker, timeoutMs: number): Promise<number> {
    const startedAt = this.clock.now();
    await waitForTerminalCondition({
      subscribe: (notify) => {
        this.listeners.add(notify);
        return () => this.listeners.delete(notify);
      },
      condition: () => this.screen.hasMarker(marker),
      processExited: () => this.process.exitCode !== null,
      timeoutMs,
      clock: this.clock,
      timeoutMessage: "Timed out waiting for the Hunk menu and fixture screen marker",
    });
    return this.clock.now() - startedAt;
  }

  /** Wait until unique mutation text is present on the emulated visible screen. */
  async waitForVisibleText(
    text: string,
    timeoutMs: number,
    startedAt = this.clock.now(),
  ): Promise<number> {
    await waitForTerminalCondition({
      subscribe: (notify) => {
        this.listeners.add(notify);
        return () => this.listeners.delete(notify);
      },
      condition: () => this.screen.getText().includes(text),
      processExited: () => this.process.exitCode !== null,
      timeoutMs,
      clock: this.clock,
      timeoutMessage: `Timed out waiting for visible refresh marker: ${text}`,
    });
    return this.clock.now() - startedAt;
  }

  /** Hash the current emulated screen without storing prose as a headline metric. */
  screenTextSha256(): string {
    return createHash("sha256").update(this.screen.getText()).digest("hex");
  }

  /** Quit through the UI, then force termination before closing ConPTY or PTY handles. */
  cleanup(timeoutMs = 2_000): Promise<boolean> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      try {
        if (this.process.exitCode === null) this.terminal.write("q");
        await Promise.race([this.process.exited, Bun.sleep(timeoutMs)]);
        if (this.process.exitCode === null) {
          this.process.kill();
          await Promise.race([this.process.exited, Bun.sleep(timeoutMs)]);
        }
        // Bun's ConPTY implementation requires the child to be killed before close on Windows.
        if (!this.terminal.closed) this.terminal.close();
        this.screen.close();
        return this.process.exitCode !== null;
      } catch {
        if (this.process.exitCode === null) {
          this.process.kill();
          await Promise.race([this.process.exited, Bun.sleep(timeoutMs)]);
        }
        // Never close a ConPTY handle around a live child; Bun can block indefinitely there.
        if (this.process.exitCode !== null && !this.terminal.closed) this.terminal.close();
        this.screen.close();
        return false;
      }
    })();
    return this.cleanupPromise;
  }
}

/** Launch the exact absolute binary and measure launch-to-emulated-screen readiness. */
export async function launchWatchTerminal(
  options: WatchTerminalLaunchOptions,
): Promise<WatchTerminalLaunchResult> {
  const clock = options.clock ?? defaultClock;
  const screen = new EmulatedTerminalScreen();
  let session: WatchTerminalSession | undefined;
  const terminal = new Bun.Terminal({
    cols: WATCH_TERMINAL_GEOMETRY.columns,
    rows: WATCH_TERMINAL_GEOMETRY.rows,
    name: "xterm-truecolor",
    data(_terminal, bytes) {
      screen.feed(bytes, () => session?.notify());
    },
  });

  const launchedAt = clock.now();
  const process = Bun.spawn(
    [
      options.executablePath,
      "diff",
      "--watch",
      "--mode",
      "stack",
      "--theme",
      "github-dark-default",
    ],
    {
      cwd: options.cwd,
      env: options.env,
      terminal,
    },
  );
  session = new WatchTerminalSession(process, terminal, screen, clock);

  try {
    await session.waitForMarker(options.marker, options.timeoutMs);
    return {
      session,
      launchToMarkerMs: clock.now() - launchedAt,
      screenText: screen.getText(),
    };
  } catch (error) {
    const terminalBytes = screen.getRawBytes();
    const cleanupComplete = await session.cleanup();
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      terminalBytes,
      cleanupComplete,
    });
  }
}
