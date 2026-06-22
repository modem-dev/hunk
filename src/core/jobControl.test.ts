import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { installJobControlInterruptSupport, installJobControlSuspendSupport } from "./jobControl";

function createTestKey(overrides: Partial<KeyEvent> = {}) {
  let defaultPrevented = false;
  let propagationStopped = false;

  return {
    ctrl: false,
    get defaultPrevented() {
      return defaultPrevented;
    },
    meta: false,
    name: "z",
    get propagationStopped() {
      return propagationStopped;
    },
    shift: false,
    preventDefault() {
      defaultPrevented = true;
    },
    stopPropagation() {
      propagationStopped = true;
    },
    ...overrides,
  } as KeyEvent;
}

function createMockRenderer() {
  const keypressListeners = new Set<(key: KeyEvent) => void>();

  return {
    isDestroyed: false,
    keyInput: {
      off(_event: "keypress", listener: (key: KeyEvent) => void) {
        keypressListeners.delete(listener);
      },
      on(_event: "keypress", listener: (key: KeyEvent) => void) {
        keypressListeners.add(listener);
      },
    },
    keypressListeners,
    resumeCalls: 0,
    suspendCalls: 0,
    emitKeypress(key: KeyEvent) {
      for (const listener of keypressListeners) {
        listener(key);
      }
    },
    resume() {
      this.resumeCalls += 1;
    },
    suspend() {
      this.suspendCalls += 1;
    },
  };
}

function createSignalHarness() {
  const listeners = new Map<NodeJS.Signals, Set<() => void>>();
  const onceWrappers = new Map<() => void, () => void>();
  const removed: NodeJS.Signals[] = [];

  return {
    emit(signal: NodeJS.Signals) {
      const signalListeners = listeners.get(signal);
      if (!signalListeners) {
        return;
      }

      const snapshot = Array.from(signalListeners);
      for (const listener of snapshot) {
        listener();
      }
    },
    listenerCount(signal: NodeJS.Signals) {
      return listeners.get(signal)?.size ?? 0;
    },
    off(signal: NodeJS.Signals, listener: () => void) {
      removed.push(signal);
      listeners.get(signal)?.delete(listener);
      const wrapped = onceWrappers.get(listener);
      if (wrapped) {
        listeners.get(signal)?.delete(wrapped);
        onceWrappers.delete(listener);
      }
    },
    once(signal: NodeJS.Signals, listener: () => void) {
      const wrapped = () => {
        listeners.get(signal)?.delete(wrapped);
        onceWrappers.delete(listener);
        listener();
      };
      onceWrappers.set(listener, wrapped);

      let signalListeners = listeners.get(signal);
      if (!signalListeners) {
        signalListeners = new Set();
        listeners.set(signal, signalListeners);
      }
      signalListeners.add(wrapped);
    },
    removed,
  };
}

describe("installJobControlInterruptSupport", () => {
  test("routes Ctrl-C through the provided shutdown callback", () => {
    const renderer = createMockRenderer();
    let interruptCalls = 0;

    installJobControlInterruptSupport(renderer, () => {
      interruptCalls += 1;
    });

    const ctrlC = createTestKey({ ctrl: true, name: "c" });
    renderer.emitKeypress(ctrlC);

    expect(ctrlC.defaultPrevented).toBe(true);
    expect(ctrlC.propagationStopped).toBe(true);
    expect(interruptCalls).toBe(1);
  });

  test("ignores non-Ctrl-C keys and removes its listener on dispose", () => {
    const renderer = createMockRenderer();
    let interruptCalls = 0;
    const support = installJobControlInterruptSupport(renderer, () => {
      interruptCalls += 1;
    });

    renderer.emitKeypress(createTestKey({ ctrl: true, name: "z" }));
    expect(interruptCalls).toBe(0);

    support.dispose();
    expect(renderer.keypressListeners.size).toBe(0);

    renderer.emitKeypress(createTestKey({ ctrl: true, name: "c" }));
    expect(interruptCalls).toBe(0);
  });

  test("ignores Ctrl-C after the renderer has already been destroyed", () => {
    const renderer = createMockRenderer();
    let interruptCalls = 0;

    installJobControlInterruptSupport(renderer, () => {
      interruptCalls += 1;
    });

    renderer.isDestroyed = true;
    const ctrlC = createTestKey({ ctrl: true, name: "c" });
    renderer.emitKeypress(ctrlC);

    expect(ctrlC.defaultPrevented).toBe(false);
    expect(ctrlC.propagationStopped).toBe(false);
    expect(interruptCalls).toBe(0);
  });
});

describe("installJobControlSuspendSupport", () => {
  test("does not install keypress listeners on Windows", () => {
    const renderer = createMockRenderer();

    installJobControlSuspendSupport(renderer, {
      platform: "win32",
    });

    expect(renderer.keypressListeners.size).toBe(0);
  });

  test("ignores keys other than Ctrl-Z", () => {
    const renderer = createMockRenderer();
    const sentSignals: NodeJS.Signals[] = [];

    installJobControlSuspendSupport(renderer, {
      kill: (_pid, signal) => sentSignals.push(signal),
      platform: "linux",
    });

    const plainZ = createTestKey({ name: "z" });
    renderer.emitKeypress(plainZ);

    expect(plainZ.defaultPrevented).toBe(false);
    expect(renderer.suspendCalls).toBe(0);
    expect(sentSignals).toEqual([]);
  });

  test("suspends the foreground process group on Ctrl-Z and resumes on SIGCONT", () => {
    const renderer = createMockRenderer();
    const signals = createSignalHarness();
    const sentSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    installJobControlSuspendSupport(renderer, {
      kill: (pid, signal) => sentSignals.push({ pid, signal }),
      off: signals.off,
      once: signals.once,
      platform: "linux",
    });

    const ctrlZ = createTestKey({ ctrl: true, name: "z" });
    renderer.emitKeypress(ctrlZ);
    expect(ctrlZ.defaultPrevented).toBe(true);
    expect(ctrlZ.propagationStopped).toBe(true);
    expect(renderer.suspendCalls).toBe(1);
    expect(signals.listenerCount("SIGCONT")).toBe(1);
    expect(sentSignals).toEqual([{ pid: 0, signal: "SIGTSTP" }]);

    signals.emit("SIGCONT");
    expect(renderer.resumeCalls).toBe(1);
    expect(signals.listenerCount("SIGCONT")).toBe(0);
  });

  test("does not resume a destroyed renderer after SIGCONT", () => {
    const renderer = createMockRenderer();
    const signals = createSignalHarness();

    installJobControlSuspendSupport(renderer, {
      kill: () => undefined,
      off: signals.off,
      once: signals.once,
      platform: "linux",
    });

    renderer.emitKeypress(createTestKey({ ctrl: true, name: "z" }));
    renderer.isDestroyed = true;
    signals.emit("SIGCONT");

    expect(renderer.suspendCalls).toBe(1);
    expect(renderer.resumeCalls).toBe(0);
  });

  test("restores the renderer if SIGTSTP cannot be sent", () => {
    const renderer = createMockRenderer();
    const signals = createSignalHarness();

    installJobControlSuspendSupport(renderer, {
      kill: () => {
        throw new Error("unsupported signal");
      },
      off: signals.off,
      once: signals.once,
      platform: "linux",
    });

    renderer.emitKeypress(createTestKey({ ctrl: true, name: "z" }));
    expect(renderer.suspendCalls).toBe(1);
    expect(renderer.resumeCalls).toBe(1);
    expect(signals.listenerCount("SIGCONT")).toBe(0);
  });

  test("dispose removes the keypress listener and pending SIGCONT listener", () => {
    const renderer = createMockRenderer();
    const signals = createSignalHarness();

    const support = installJobControlSuspendSupport(renderer, {
      kill: () => undefined,
      off: signals.off,
      once: signals.once,
      platform: "linux",
    });

    renderer.emitKeypress(createTestKey({ ctrl: true, name: "z" }));
    support.dispose();

    expect(renderer.keypressListeners.size).toBe(0);
    expect(signals.listenerCount("SIGCONT")).toBe(0);

    renderer.emitKeypress(createTestKey({ ctrl: true, name: "z" }));
    expect(renderer.suspendCalls).toBe(1);
  });
});
