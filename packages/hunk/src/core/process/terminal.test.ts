import { describe, expect, test } from "bun:test";
import type { CliInput } from "../run/commandInputs";
import {
  type ControllingTerminalDeps,
  installTerminalDisconnectSupport,
  openControllingTerminal,
  resolveControllingTerminalDevice,
  resolveRuntimeCliInput,
  shouldUseMouseForApp,
  shouldUsePagerMode,
  usesPipedPatchInput,
} from "./terminal";

function createTestTerminalInputEvents(
  state: { isTTY?: boolean; destroyed?: boolean; readableEnded?: boolean } = {},
) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    isTTY: true,
    ...state,
    emit(event: "close" | "end" | "error") {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
    listenerCount(event: "close" | "end" | "error") {
      return listeners.get(event)?.size ?? 0;
    },
    on(event: "close" | "end" | "error", listener: (...args: unknown[]) => void) {
      let eventListeners = listeners.get(event);
      if (!eventListeners) {
        eventListeners = new Set();
        listeners.set(event, eventListeners);
      }
      eventListeners.add(listener);
    },
    off(event: "close" | "end" | "error", listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
    },
  };
}

function createPatchInput(file?: string, pager = false): CliInput {
  return {
    kind: "patch",
    file,
    options: {
      mode: "auto",
      pager,
    },
  };
}

describe("terminal runtime defaults", () => {
  test("treats stdin patch mode as pager-style when stdin is piped", () => {
    const input = createPatchInput("-", false);

    expect(usesPipedPatchInput(input, false)).toBe(true);
    expect(shouldUsePagerMode(input, false)).toBe(true);
    expect(resolveRuntimeCliInput(input, false).options.pager).toBe(true);
  });

  test("does not force pager mode for patch files or interactive stdin", () => {
    expect(usesPipedPatchInput(createPatchInput("changes.patch"), false)).toBe(false);
    expect(shouldUsePagerMode(createPatchInput("changes.patch"), false)).toBe(false);
    expect(shouldUsePagerMode(createPatchInput("-"), true)).toBe(false);
  });

  test("keeps explicit pager mode enabled", () => {
    const input = createPatchInput(undefined, true);

    expect(shouldUsePagerMode(input, true)).toBe(true);
    expect(resolveRuntimeCliInput(input, true).options.pager).toBe(true);
  });
});

describe("app mouse support", () => {
  test("enables mouse for interactive stdin", () => {
    expect(
      shouldUseMouseForApp({
        stdinIsTTY: true,
        hasControllingTerminal: false,
      }),
    ).toBe(true);
  });

  test("enables mouse when a controlling terminal is attached", () => {
    expect(
      shouldUseMouseForApp({
        stdinIsTTY: false,
        hasControllingTerminal: true,
      }),
    ).toBe(true);
  });

  test("disables mouse when no interactive terminal is available", () => {
    expect(
      shouldUseMouseForApp({
        stdinIsTTY: false,
        hasControllingTerminal: false,
      }),
    ).toBe(false);
  });
});

/** Build controlling-terminal deps around an in-memory device so no real tty is touched. */
function createTestControllingTerminalDeps(
  overrides: Partial<ControllingTerminalDeps> & {
    /** Chunks the fake device delivers, in order; the stream stays open after the last one. */
    chunks?: Uint8Array[];
  } = {},
) {
  const log: string[] = [];
  const rawModeCalls: boolean[] = [];
  const { chunks = [], ...depOverrides } = overrides;
  const pending = chunks.map((chunk) => chunk);
  let cancelled = false;
  let release: (() => void) | undefined;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pending.shift();
      if (next) {
        controller.enqueue(next);
        return;
      }
      // Emulate a terminal with nothing typed yet: the read stays pending until cancel.
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    cancel() {
      cancelled = true;
      release?.();
    },
  });
  const deps: ControllingTerminalDeps = {
    candidateFds: [1],
    isatty: () => true,
    readlinkSync: () => {
      throw new Error("no procfs");
    },
    fstatSync: () => ({ rdev: 42 }),
    readdirSync: () => ["null", "tty", "ttys001", "ttys007"],
    statSync: (path) => ({
      rdev: path === "/dev/ttys007" ? 42 : 7,
      isCharacterDevice: () => true,
    }),
    openSync: (path, flags) => {
      log.push(`open ${String(path)} ${String(flags)}`);
      return 11;
    },
    closeSync: (fd) => {
      log.push(`close ${fd}`);
    },
    createRawModeStream: () => {
      const handle = {
        isRaw: false,
        setRawMode(flag: boolean) {
          rawModeCalls.push(flag);
          handle.isRaw = flag;
          return handle as never;
        },
      };
      return handle;
    },
    openDeviceStream: (devicePath) => {
      log.push(`stream ${devicePath}`);
      return source;
    },
    ...depOverrides,
  };
  return {
    deps,
    log,
    rawModeCalls,
    get cancelled() {
      return cancelled;
    },
  };
}

describe("controlling terminal device resolution", () => {
  test("prefers the procfs link for a terminal descriptor", () => {
    const { deps } = createTestControllingTerminalDeps({
      readlinkSync: (path) => {
        expect(path).toBe("/proc/self/fd/1");
        return "/dev/pts/4";
      },
    });
    expect(resolveControllingTerminalDevice(deps)).toBe("/dev/pts/4");
  });

  test("matches the device by rdev when procfs is unavailable, skipping the /dev/tty alias", () => {
    const { deps } = createTestControllingTerminalDeps();
    expect(resolveControllingTerminalDevice(deps)).toBe("/dev/ttys007");
  });

  test("skips descriptors that are not terminals and reports null without a match", () => {
    const { deps } = createTestControllingTerminalDeps({
      candidateFds: [1, 2],
      isatty: (fd) => fd === 2,
      fstatSync: () => ({ rdev: 99 }),
    });
    expect(resolveControllingTerminalDevice(deps)).toBeNull();
  });
});

describe("controlling terminal attachment", () => {
  test("opens the resolved device for raw mode and streams it without a blocking read", async () => {
    const harness = createTestControllingTerminalDeps({
      chunks: [new TextEncoder().encode("q")],
    });
    const controllingTerminal = openControllingTerminal(harness.deps);
    expect(controllingTerminal).not.toBeNull();
    expect(harness.log).toEqual(["open /dev/ttys007 r", "stream /dev/ttys007"]);

    const stdin = controllingTerminal!.stdin;
    expect(stdin.isTTY).toBe(true);
    stdin.setRawMode(true);
    expect(stdin.isRaw).toBe(true);
    expect(harness.rawModeCalls).toEqual([true]);

    const first = await new Promise<Buffer>((resolve) => stdin.once("data", resolve));
    expect(first.toString()).toBe("q");

    // Teardown lands on a later tick while the next read is already pending, which is the
    // shape that used to strand the process behind a blocking read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closed = new Promise<void>((resolve) => stdin.once("close", () => resolve()));
    controllingTerminal!.close();
    await closed;
    expect(harness.cancelled).toBe(true);
    expect(harness.log.at(-1)).toBe("close 11");
    expect(stdin.destroyed).toBe(true);
  });

  test("returns null when no terminal device resolves", () => {
    const { deps, log } = createTestControllingTerminalDeps({ isatty: () => false });
    expect(openControllingTerminal(deps)).toBeNull();
    expect(log).toEqual([]);
  });

  test("returns null and releases the descriptor when the device stream cannot open", () => {
    const { deps, log } = createTestControllingTerminalDeps({
      openDeviceStream: () => {
        throw new Error("EINVAL");
      },
    });
    expect(openControllingTerminal(deps)).toBeNull();
    expect(log).toEqual(["open /dev/ttys007 r", "close 11"]);
  });
});

describe("terminal disconnect support", () => {
  test.each(["close", "end", "error"] as const)("shuts down once on %s", (event) => {
    const input = createTestTerminalInputEvents();
    let disconnectCalls = 0;
    installTerminalDisconnectSupport(input, () => {
      disconnectCalls += 1;
    });

    input.emit(event);
    input.emit(event);

    expect(disconnectCalls).toBe(1);
  });

  test("dispose removes every input listener", () => {
    const input = createTestTerminalInputEvents();
    let disconnectCalls = 0;
    const support = installTerminalDisconnectSupport(input, () => {
      disconnectCalls += 1;
    });

    support.dispose();

    expect(input.listenerCount("close")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    input.emit("close");
    expect(disconnectCalls).toBe(0);
  });

  test.each(["destroyed", "readableEnded"] as const)(
    "shuts down when input is already %s",
    async (state) => {
      const input = createTestTerminalInputEvents({ [state]: true });
      let disconnectCalls = 0;
      installTerminalDisconnectSupport(input, () => {
        disconnectCalls += 1;
      });

      await Promise.resolve();

      expect(disconnectCalls).toBe(1);
    },
  );

  // Non-interactive input ends the moment the renderer resumes it.
  test.each([{ isTTY: false }, { isTTY: undefined }])(
    "ignores non-terminal input (%o)",
    async (state) => {
      const input = createTestTerminalInputEvents({ ...state, readableEnded: true });
      let disconnectCalls = 0;
      installTerminalDisconnectSupport(input, () => {
        disconnectCalls += 1;
      });

      await Promise.resolve();
      input.emit("end");
      input.emit("close");
      input.emit("error");

      expect(input.listenerCount("end")).toBe(0);
      expect(disconnectCalls).toBe(0);
    },
  );
});
