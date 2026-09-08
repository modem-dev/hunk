import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useCallback, useState } from "react";
import type {
  ExtensionCommandControls,
  ExtensionKeyboardMode,
  ExtensionKeyboardModeContext,
} from "../../extension-api/types";
import {
  createEmptyExtensionRegistry,
  type ExtensionRegistry,
  type RegisteredKeyboardMode,
} from "../../extensions/types";
import { useKeyboardModeController } from "./useKeyboardModeController";

interface HarnessState {
  registry: ExtensionRegistry;
  modes: RegisteredKeyboardMode[];
}

/** Register one test mode under an extension id. */
function registered(
  extensionId: string,
  id: string,
  callbacks: Partial<ExtensionKeyboardMode> = {},
): RegisteredKeyboardMode {
  return {
    extensionId,
    mode: {
      id,
      title: `${extensionId} ${id}`,
      onKey: () => "handled",
      ...callbacks,
    },
  };
}

/** Create a ready registry carrying exactly the given registrations. */
function registryWith(modes: RegisteredKeyboardMode[]) {
  const registry = createEmptyExtensionRegistry();
  registry.eventBusPhase = "ready";
  registry.keyboardModes.push(...modes);
  return registry;
}

/** Mount the controller with replaceable registry authority. */
async function renderController(initial: HarnessState) {
  let controller!: ReturnType<typeof useKeyboardModeController>;
  let update!: (next: Partial<HarnessState>) => void;
  const notices: string[] = [];
  const commands: ExtensionCommandControls = {
    isEnabled: () => true,
    execute: () => true,
  };

  function Harness() {
    const [state, setState] = useState(initial);
    update = (next) => setState((current) => ({ ...current, ...next }));
    const showNotice = useCallback((message: string) => notices.push(message), []);
    controller = useKeyboardModeController({
      commands,
      createHighlightControls: () => ({ refresh: () => {} }),
      cwd: "/repo",
      modes: state.modes,
      notify: (message) => notices.push(message),
      registry: state.registry,
      showNotice,
    });
    return null;
  }

  const setup = await testRender(<Harness />, { width: 40, height: 4 });
  await act(async () => setup.renderOnce());
  return {
    setup,
    notices,
    controller: () => controller,
    update: (next: Partial<HarnessState>) => update(next),
  };
}

describe("useKeyboardModeController", () => {
  test("scopes observation and exit while allowing a later extension to replace the mode", async () => {
    const events: string[] = [];
    const alpha = registered("alpha", "normal", {
      onEnter: () => events.push("enter alpha"),
      onExit: () => events.push("exit alpha"),
    });
    const beta = registered("beta", "normal", {
      onEnter: () => events.push("enter beta"),
    });
    const registry = registryWith([alpha, beta]);
    const harness = await renderController({ registry, modes: [alpha, beta] });

    try {
      const alphaControls = harness.controller().createControls("alpha", registry);
      const betaControls = harness.controller().createControls("beta", registry);
      await act(async () => expect(alphaControls.enterMode("normal")).toBe(true));
      expect(alphaControls.isActive()).toBe(true);
      expect(betaControls.isActive()).toBe(false);
      expect(betaControls.exitMode()).toBe(false);

      await act(async () => expect(betaControls.enterMode("normal")).toBe(true));
      expect(alphaControls.isActive()).toBe(false);
      expect(betaControls.isActive("normal")).toBe(true);
      expect(events).toEqual(["enter alpha", "exit alpha", "enter beta"]);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("retires closed registry authority synchronously and makes retained controls inert", async () => {
    let exits = 0;
    const mode = registered("vim", "normal", { onExit: () => (exits += 1) });
    const registry = registryWith([mode]);
    const harness = await renderController({ registry, modes: [mode] });
    const controls = harness.controller().createControls("vim", registry);

    try {
      await act(async () => expect(controls.enterMode("normal")).toBe(true));
      registry.eventBusPhase = "closed";
      // No React render announces closure: the live routing probe must still see it immediately.
      let active = true;
      await act(async () => {
        active = harness.controller().isModeActive();
      });
      expect(active).toBe(false);
      expect(exits).toBe(1);
      expect(controls.isActive()).toBe(false);
      expect(controls.enterMode("normal")).toBe(false);
      expect(controls.exitMode()).toBe(false);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("keeps lifecycle callbacks from changing keyboard ownership", async () => {
    const attempts: boolean[] = [];
    const attemptOwnershipChange = (ctx: ExtensionKeyboardModeContext) => {
      attempts.push(ctx.keyboardModes.enterMode("gamma"), ctx.keyboardModes.exitMode());
    };
    const alpha = registered("vim", "alpha", {
      onEnter: attemptOwnershipChange,
      onExit: attemptOwnershipChange,
    });
    const beta = registered("vim", "beta");
    const gamma = registered("vim", "gamma");
    const registry = registryWith([alpha, beta, gamma]);
    const harness = await renderController({ registry, modes: [alpha, beta, gamma] });
    const controls = harness.controller().createControls("vim", registry);

    try {
      await act(async () => expect(controls.enterMode("alpha")).toBe(true));
      await act(async () => expect(controls.enterMode("beta")).toBe(true));
      expect(attempts).toEqual([false, false, false, false]);
      expect(controls.isActive("beta")).toBe(true);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("cleans up a failed onEnter and permits a later command entry", async () => {
    let failedExits = 0;
    const failed = registered("vim", "failed", {
      onEnter: () => {
        throw new Error("entry failed");
      },
      onExit: () => (failedExits += 1),
    });
    const healthy = registered("vim", "healthy");
    const registry = registryWith([failed, healthy]);
    const harness = await renderController({ registry, modes: [failed, healthy] });
    const controls = harness.controller().createControls("vim", registry);

    try {
      await act(async () => expect(controls.enterMode("failed")).toBe(false));
      expect(failedExits).toBe(1);
      expect(controls.isActive()).toBe(false);
      expect(harness.notices).toContain(
        'Extension vim keyboard mode "failed" failed onEnter • entry failed',
      );

      await act(async () => expect(controls.enterMode("healthy")).toBe(true));
      expect(controls.isActive("healthy")).toBe(true);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("keeps an onKey replacement when its predecessor returns exit", async () => {
    let alphaExits = 0;
    const alpha = registered("vim", "alpha", {
      onExit: () => (alphaExits += 1),
      onKey: (_key, ctx) => {
        expect(ctx.keyboardModes.enterMode("beta")).toBe(true);
        return "exit";
      },
    });
    const beta = registered("vim", "beta");
    const registry = registryWith([alpha, beta]);
    const harness = await renderController({ registry, modes: [alpha, beta] });
    const controls = harness.controller().createControls("vim", registry);

    try {
      await act(async () => expect(controls.enterMode("alpha")).toBe(true));
      let result = "pass";
      await act(async () => {
        result = harness.controller().sendModeKey({ name: "x" });
      });
      expect(result).toBe("handled");
      expect(alphaExits).toBe(1);
      expect(controls.isActive("beta")).toBe(true);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("host exit invalidates onExit controls synchronously and for deferred work", async () => {
    const attempts: boolean[] = [];
    const gamma = registered("vim", "gamma");
    const alpha = registered("vim", "alpha", {
      onExit: (ctx) => {
        attempts.push(ctx.keyboardModes.isActive("alpha"));
        attempts.push(ctx.keyboardModes.exitMode());
        attempts.push(ctx.keyboardModes.enterMode("gamma"));
        queueMicrotask(() => attempts.push(ctx.keyboardModes.enterMode("gamma")));
      },
    });
    const registry = registryWith([alpha, gamma]);
    const harness = await renderController({ registry, modes: [alpha, gamma] });
    const controls = harness.controller().createControls("vim", registry);

    try {
      await act(async () => expect(controls.enterMode("alpha")).toBe(true));
      await act(async () => harness.controller().exitMode());
      await Promise.resolve();

      expect(attempts).toEqual([false, false, false, false]);
      expect(controls.isActive()).toBe(false);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("old mode contexts cannot inspect or exit a same-extension replacement", async () => {
    let oldContext!: Parameters<NonNullable<ExtensionKeyboardMode["onEnter"]>>[0];
    const alpha = registered("vim", "alpha", { onEnter: (ctx) => (oldContext = ctx) });
    const beta = registered("vim", "beta");
    const registry = registryWith([alpha, beta]);
    const harness = await renderController({ registry, modes: [alpha, beta] });
    const controls = harness.controller().createControls("vim", registry);

    try {
      await act(async () => expect(controls.enterMode("alpha")).toBe(true));
      await act(async () => expect(controls.enterMode("beta")).toBe(true));

      expect(oldContext.keyboardModes.isActive()).toBe(false);
      expect(oldContext.keyboardModes.exitMode()).toBe(false);
      expect(oldContext.keyboardModes.enterMode("alpha")).toBe(false);
      expect(controls.isActive("beta")).toBe(true);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("keeps a mode across same-registry content updates and exits on registry identity replacement", async () => {
    let exits = 0;
    const mode = registered("vim", "normal", { onExit: () => (exits += 1) });
    const registry = registryWith([mode]);
    const harness = await renderController({ registry, modes: [mode] });
    const controls = harness.controller().createControls("vim", registry);

    try {
      await act(async () => expect(controls.enterMode("normal")).toBe(true));
      await act(async () => harness.update({ modes: [mode] }));
      expect(controls.isActive("normal")).toBe(true);

      const replacementMode = registered("vim", "normal");
      const replacementRegistry = registryWith([replacementMode]);
      await act(async () =>
        harness.update({ registry: replacementRegistry, modes: [replacementMode] }),
      );
      expect(harness.controller().isModeActive()).toBe(false);
      expect(exits).toBe(1);
      expect(controls.isActive()).toBe(false);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("unmount exits once and makes retained command controls inert", async () => {
    let exits = 0;
    const mode = registered("vim", "normal", { onExit: () => (exits += 1) });
    const registry = registryWith([mode]);
    const harness = await renderController({ registry, modes: [mode] });
    const controls = harness.controller().createControls("vim", registry);

    await act(async () => expect(controls.enterMode("normal")).toBe(true));
    await act(async () => harness.setup.renderer.destroy());

    expect(exits).toBe(1);
    expect(controls.isActive()).toBe(false);
    expect(controls.exitMode()).toBe(false);
    expect(controls.enterMode("normal")).toBe(false);
  });

  test("contains a throwing key handler and exits it through the controller", async () => {
    let exits = 0;
    const mode = registered("vim", "normal", {
      onKey: () => {
        throw new Error("key failed");
      },
      onExit: () => (exits += 1),
    });
    const registry = registryWith([mode]);
    const harness = await renderController({ registry, modes: [mode] });
    const controls = harness.controller().createControls("vim", registry);

    try {
      await act(async () => expect(controls.enterMode("normal")).toBe(true));
      expect(harness.controller().sendModeKey({ name: "j" })).toBe("exit");
      await act(async () => harness.controller().exitMode());
      expect(exits).toBe(1);
      expect(harness.notices).toContain(
        'Extension vim keyboard mode "normal" failed onKey • key failed',
      );
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });
});
