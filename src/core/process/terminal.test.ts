import { describe, expect, test } from "bun:test";
import type { CliInput } from "../run/commandInputs";
import {
  installTerminalDisconnectSupport,
  openControllingTerminal,
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

describe("controlling terminal attachment", () => {
  test("opens /dev/tty for read and closes the input stream", () => {
    const calls: Array<[string, string]> = [];
    let stdinDestroyed = false;

    const stdin = {
      destroy() {
        stdinDestroyed = true;
      },
    } as never;

    const controllingTerminal = openControllingTerminal({
      openSync(path, flags) {
        calls.push([String(path), String(flags)]);
        return 11;
      },
      createReadStream(fd) {
        expect(fd).toBe(11);
        return stdin;
      },
    });

    expect(controllingTerminal).not.toBeNull();
    expect(calls).toEqual([["/dev/tty", "r"]]);
    expect(controllingTerminal?.stdin).toBe(stdin);

    controllingTerminal?.close();
    expect(stdinDestroyed).toBe(true);
  });

  test("returns null when the controlling terminal cannot be opened", () => {
    const controllingTerminal = openControllingTerminal({
      openSync() {
        throw new Error("no tty");
      },
      createReadStream() {
        throw new Error("unreachable");
      },
    });

    expect(controllingTerminal).toBeNull();
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
