import fs from "node:fs";
import { Readable } from "node:stream";
import tty from "node:tty";
import type { CliInput } from "../run/commandInputs";

export interface AppMouseOptions {
  stdinIsTTY?: boolean;
  hasControllingTerminal?: boolean;
}

/** Detect the stdin-pipe patch workflow used by `git diff` pagers. */
export function usesPipedPatchInput(input: CliInput, stdinIsTTY = Boolean(process.stdin.isTTY)) {
  return input.kind === "patch" && (!input.file || input.file === "-") && !stdinIsTTY;
}

/** Enable pager-style chrome automatically when Hunk is consuming a piped patch. */
export function shouldUsePagerMode(input: CliInput, stdinIsTTY = Boolean(process.stdin.isTTY)) {
  return Boolean(input.options.pager) || usesPipedPatchInput(input, stdinIsTTY);
}

/** Apply runtime CLI defaults that depend on whether stdin is an interactive terminal. */
export function resolveRuntimeCliInput(
  input: CliInput,
  stdinIsTTY = Boolean(process.stdin.isTTY),
): CliInput {
  return {
    ...input,
    options: {
      ...input.options,
      pager: shouldUsePagerMode(input, stdinIsTTY),
    },
  } as CliInput;
}

/** Keep mouse support tied to terminal interactivity instead of pager chrome mode. */
export function shouldUseMouseForApp({
  stdinIsTTY = Boolean(process.stdin.isTTY),
  hasControllingTerminal = false,
}: AppMouseOptions = {}) {
  return stdinIsTTY || hasControllingTerminal;
}

export interface ControllingTerminal {
  stdin: ControllingTerminalInput;
  close: () => void;
}

type TerminalDisconnectEvent = "close" | "end" | "error";

export interface TerminalInputEvents {
  isTTY?: boolean;
  destroyed?: boolean;
  readableEnded?: boolean;
  on: (event: TerminalDisconnectEvent, listener: (...args: unknown[]) => void) => unknown;
  off: (event: TerminalDisconnectEvent, listener: (...args: unknown[]) => void) => unknown;
}

export interface TerminalDisconnectSupport {
  dispose: () => void;
}

/** Shut the app down when its renderer input is closed or revoked by the terminal host. */
export function installTerminalDisconnectSupport(
  input: TerminalInputEvents,
  onDisconnect: () => void,
): TerminalDisconnectSupport {
  if (input.isTTY !== true) {
    return { dispose: () => undefined };
  }

  const events: TerminalDisconnectEvent[] = ["close", "end", "error"];
  let disposed = false;

  const disconnect = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    onDisconnect();
  };

  for (const event of events) {
    input.on(event, disconnect);
  }

  // Stream ended before listeners handle disconnect
  if (input.destroyed || input.readableEnded) {
    queueMicrotask(disconnect);
  }

  return {
    dispose: () => {
      disposed = true;
      for (const event of events) {
        input.off(event, disconnect);
      }
    },
  };
}

/** Terminal construction hooks so tests can cover device resolution and attach behavior. */
export interface ControllingTerminalDeps {
  /** Descriptors that may be attached to the terminal, checked in order. */
  candidateFds: number[];
  isatty: typeof tty.isatty;
  readlinkSync: (path: string) => string;
  fstatSync: (fd: number) => { rdev: number };
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { rdev: number; isCharacterDevice(): boolean };
  openSync: typeof fs.openSync;
  closeSync: typeof fs.closeSync;
  /** Builds the dormant raw-mode handle for an open device descriptor. */
  createRawModeStream: (fd: number) => Pick<tty.ReadStream, "setRawMode" | "isRaw">;
  /** Opens the poll-driven byte source for a terminal device path. */
  openDeviceStream: (devicePath: string) => ReadableStream<Uint8Array>;
}

const defaultControllingTerminalDeps: ControllingTerminalDeps = {
  candidateFds: [1, 2],
  isatty: tty.isatty,
  readlinkSync: (path) => fs.readlinkSync(path),
  fstatSync: (fd) => fs.fstatSync(fd),
  readdirSync: (path) => fs.readdirSync(path),
  statSync: (path) => fs.statSync(path),
  openSync: fs.openSync,
  closeSync: fs.closeSync,
  createRawModeStream: (fd) => new tty.ReadStream(fd),
  openDeviceStream: (devicePath) => Bun.file(devicePath).stream(),
};

/**
 * Resolve the real device node (`/dev/ttys003`, `/dev/pts/4`) behind the terminal that
 * `candidateFds` write to. The `/dev/tty` alias is not enough: macOS kqueue refuses to poll it
 * with EINVAL, so the non-blocking reader below needs the concrete node. Linux answers through
 * `/proc/self/fd`; elsewhere the device is matched by `rdev` among the `/dev` terminal entries.
 */
export function resolveControllingTerminalDevice(
  deps: ControllingTerminalDeps = defaultControllingTerminalDeps,
): string | null {
  for (const fd of deps.candidateFds) {
    if (!deps.isatty(fd)) continue;
    try {
      const target = deps.readlinkSync(`/proc/self/fd/${fd}`);
      if (target.startsWith("/dev/")) return target;
    } catch {
      // No procfs; fall through to the device scan.
    }
    let rdev: number;
    try {
      rdev = deps.fstatSync(fd).rdev;
    } catch {
      continue;
    }
    let entries: string[];
    try {
      entries = deps.readdirSync("/dev");
    } catch {
      continue;
    }
    for (const name of entries) {
      // `tty` itself is the alias we must avoid; the per-session nodes carry a suffix.
      if (name === "tty" || !(name.startsWith("tty") || name.startsWith("pts"))) continue;
      const devicePath = `/dev/${name}`;
      try {
        const stat = deps.statSync(devicePath);
        if (stat.isCharacterDevice() && stat.rdev === rdev) return devicePath;
      } catch {
        // Entries can disappear mid-scan; keep looking.
      }
    }
  }
  return null;
}

/**
 * Streams keyboard input from a terminal device without parking a blocking read on Bun's thread
 * pool.
 *
 * Bun implements `tty.ReadStream(fd)` as `fs.ReadStream`, so each read is a blocking `read(2)` on a
 * worker thread and `destroy()` waits for that read to return, which only happens when the
 * terminal delivers more input. Bun >= 1.4.3 issues the next read before the app's asynchronous
 * teardown runs, so `git diff | hunk pager` would stay alive after `q` until the user pressed
 * Enter. Only `process.stdin` gets Bun's poll-driven native reader; this class rebuilds that path
 * for an arbitrary device: bytes come from `Bun.file(devicePath).stream()`, whose pending read is
 * poll-driven and whose `cancel()` releases the event loop, while raw mode goes through a dormant
 * `tty.ReadStream` on a second descriptor because termios state belongs to the device, not to a
 * descriptor.
 *
 * Invariants:
 * - At most one native read is in flight; `_read` is a no-op while one is pending.
 * - `_destroy` cancels the native reader before closing the raw-mode descriptor, so an in-flight
 *   read settles as done instead of holding the process open.
 * - The raw-mode `tty.ReadStream` stays dormant: Bun's `fs.ReadStream` only issues `read(2)` from
 *   `_read`, which runs once something calls `read()`/`resume()`/`pipe()` or attaches a
 *   `data`/`readable` listener. Never do any of those on it; a flowing handle would steal
 *   keystrokes from the device stream and park the blocking read this class exists to avoid.
 * - That handle owns no native resource or finalizer, so `_destroy` closes its descriptor with
 *   `closeSync` instead of destroying the stream. Callers leave raw mode before destroying
 *   (OpenTUI does so before `onDestroy`); after `_destroy` the descriptor number may belong to an
 *   unrelated file, so the handle must not be touched again.
 */
export class ControllingTerminalInput extends Readable {
  readonly isTTY = true;
  isRaw = false;
  readonly fd: number;
  readonly #rawMode: Pick<tty.ReadStream, "setRawMode" | "isRaw">;
  readonly #source: ReadableStream<Uint8Array>;
  readonly #closeSync: typeof fs.closeSync;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #reading = false;

  constructor(devicePath: string, deps: ControllingTerminalDeps = defaultControllingTerminalDeps) {
    super();
    this.fd = deps.openSync(devicePath, "r");
    this.#closeSync = deps.closeSync;
    try {
      this.#rawMode = deps.createRawModeStream(this.fd);
      this.#source = deps.openDeviceStream(devicePath);
    } catch (error) {
      deps.closeSync(this.fd);
      throw error;
    }
  }

  /** Switch the terminal between raw and cooked mode, mirroring `tty.ReadStream#setRawMode`. */
  setRawMode(flag: boolean): this {
    this.#rawMode.setRawMode(flag);
    this.isRaw = this.#rawMode.isRaw;
    return this;
  }

  /**
   * Accept `ref()` for `tty.ReadStream` shape compatibility only; it does not change event-loop
   * liveness. Once the first read is issued, the device stream keeps the loop alive until
   * `destroy()` cancels the reader; completed reads, `pause()`, and `unref()` do not release it.
   * That keeps the pager alive while idle (OpenTUI's keep-alive timer only runs for
   * `process.stdin`), so callers must `destroy()` through `ControllingTerminal.close` to exit.
   */
  ref(): this {
    return this;
  }

  /** Accept `unref()` as a no-op; see `ref()`. Only `destroy()` releases the loop. */
  unref(): this {
    return this;
  }

  override _read(): void {
    if (this.#reading) return;
    const reader = (this.#reader ??= this.#source.getReader());
    this.#reading = true;
    reader.read().then(
      ({ value, done }) => {
        this.#reading = false;
        // A cancelled reader settles as done after destroy; the stream already finished.
        if (reader !== this.#reader) return;
        if (done || value === undefined) {
          this.push(null);
          return;
        }
        this.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      },
      (error: unknown) => {
        this.#reading = false;
        if (reader === this.#reader)
          this.destroy(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const reader = this.#reader;
    this.#reader = undefined;
    const release = () => {
      try {
        this.#closeSync(this.fd);
      } catch {
        // The descriptor is already gone; nothing else holds the device.
      }
      callback(error);
    };
    const cancelled = reader ? reader.cancel() : this.#source.cancel();
    cancelled.then(release, release);
  }
}

/**
 * Open the controlling terminal for input so the UI can stay interactive while stdin carries patch
 * data. Rendering continues through the existing stdout stream. Returns null when no terminal
 * device can be resolved or opened, which callers treat as "no interactive terminal".
 */
export function openControllingTerminal(
  deps: ControllingTerminalDeps = defaultControllingTerminalDeps,
): ControllingTerminal | null {
  try {
    const devicePath = resolveControllingTerminalDevice(deps);
    if (!devicePath) return null;
    const stdin = new ControllingTerminalInput(devicePath, deps);

    return {
      stdin,
      close: () => {
        stdin.destroy();
      },
    };
  } catch {
    return null;
  }
}
