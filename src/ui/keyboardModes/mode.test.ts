import { describe, expect, test } from "bun:test";
import type {
  ExtensionKeyboardMode,
  ExtensionKeyboardModeContext,
} from "../../extension-api/types";
import { createEmptyExtensionRegistry, type RegisteredKeyboardMode } from "../../extensions/types";
import {
  deliverSessionKeyboardModeKey,
  runSessionKeyboardModeLifecycle,
  sessionKeyboardModeStatusHint,
  sessionKeyboardModeStillValid,
  type ActiveSessionKeyboardMode,
} from "./mode";

/** Build one active record around a mode callback. */
function activeFor(mode: ExtensionKeyboardMode): ActiveSessionKeyboardMode {
  const registry = createEmptyExtensionRegistry();
  registry.eventBusPhase = "ready";
  const registered: RegisteredKeyboardMode = { extensionId: "vim", mode };
  registry.keyboardModes.push(registered);
  return {
    extensionId: "vim",
    modeId: mode.id,
    registered,
    mode,
    registry,
    ctx: {
      cwd: "/repo",
      notify: () => {},
      commands: {} as ExtensionKeyboardModeContext["commands"],
      keyboardModes: {} as ExtensionKeyboardModeContext["keyboardModes"],
      highlights: {} as ExtensionKeyboardModeContext["highlights"],
    },
  };
}

describe("session keyboard mode helpers", () => {
  test("ties validity to registry authority and registration identity", () => {
    const active = activeFor({ id: "normal", title: "Vim normal", onKey: () => "handled" });

    expect(sessionKeyboardModeStillValid(active, active.registry, [active.registered])).toBe(true);
    active.registry.eventBusPhase = "closed";
    expect(sessionKeyboardModeStillValid(active, active.registry, [active.registered])).toBe(false);
    active.registry.eventBusPhase = "ready";
    expect(
      sessionKeyboardModeStillValid(active, createEmptyExtensionRegistry(), [active.registered]),
    ).toBe(false);
    expect(sessionKeyboardModeStillValid(active, active.registry, [])).toBe(false);
  });

  test("formats a persistent attributed, terminal-safe status hint", () => {
    const active = activeFor({
      id: "normal",
      title: "Vim\u001b]0;spoof\u0007 normal",
      onKey: () => "handled",
    });
    expect(sessionKeyboardModeStatusHint(active)).toBe("Vim normal — ext vim:normal — Esc exits");
  });

  test("normalizes invalid results, contains throws, and refuses async onKey", async () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);

    expect(
      deliverSessionKeyboardModeKey(
        activeFor({ id: "normal", title: "Normal", onKey: () => undefined as never }),
        { name: "j" },
        warn,
      ),
    ).toBe("pass");
    expect(
      deliverSessionKeyboardModeKey(
        activeFor({
          id: "normal",
          title: "Normal",
          onKey: (() => Promise.resolve("handled")) as never,
        }),
        { name: "j" },
        warn,
      ),
    ).toBe("exit");
    expect(
      deliverSessionKeyboardModeKey(
        activeFor({
          id: "normal",
          title: "Normal",
          onKey: () => {
            throw new Error("boom");
          },
        }),
        { name: "j" },
        warn,
      ),
    ).toBe("exit");
    await Promise.resolve();

    expect(warnings).toEqual([
      'Extension vim keyboard mode "normal" failed onKey • onKey must return synchronously',
      'Extension vim keyboard mode "normal" failed onKey • boom',
    ]);
  });

  test("contains lifecycle throws and async callbacks", async () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    const asyncEntry = activeFor({
      id: "normal",
      title: "Normal",
      onEnter: (() => Promise.resolve()) as never,
      onKey: () => "handled",
    });
    expect(runSessionKeyboardModeLifecycle(asyncEntry, "onEnter", warn)).toBe(false);

    const brokenExit = activeFor({
      id: "normal",
      title: "Normal",
      onExit: () => {
        throw new Error("teardown");
      },
      onKey: () => "handled",
    });
    expect(runSessionKeyboardModeLifecycle(brokenExit, "onExit", warn)).toBe(false);
    await Promise.resolve();

    expect(warnings).toEqual([
      'Extension vim keyboard mode "normal" failed onEnter • onEnter must return synchronously',
      'Extension vim keyboard mode "normal" failed onExit • teardown',
    ]);
  });
});
