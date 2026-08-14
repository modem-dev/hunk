import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExtensionCommandControls,
  ExtensionContext,
  ExtensionKeyboardModeContext,
  ExtensionKeyboardModeControls,
  ExtensionKeyboardModeKeyResult,
  ExtensionKeyEvent,
  ExtensionLineHighlightControls,
  ExtensionNotifyType,
} from "../../extension-api/types";
import type { ExtensionRegistry, RegisteredKeyboardMode } from "../../extensions/types";
import {
  deliverSessionKeyboardModeKey,
  runSessionKeyboardModeLifecycle,
  sessionKeyboardModeDisplayTitle,
  sessionKeyboardModeStatusHint,
  sessionKeyboardModeStillValid,
  type ActiveSessionKeyboardMode,
} from "./mode";

/** Activation identity retained only for the lifetime of one mode context. */
type KeyboardModeControlScope = { active: ActiveSessionKeyboardMode | null };

export interface KeyboardModeController {
  /** Build controls restricted to one extension and registry generation. */
  createControls: (
    extensionId: string,
    owningRegistry: ExtensionRegistry | undefined,
  ) => ExtensionKeyboardModeControls;
  /** Whether a live session mode owns review-level keys. */
  isModeActive: () => boolean;
  /** Persistent status text for the active mode. */
  modeStatusHint: string | null;
  /** Human-readable active title for host menu affordances. */
  activeModeTitle: string | null;
  /** Host-owned teardown used by Escape, status, menus, and unmount. */
  exitMode: () => void;
  /** Offer one frozen public key snapshot to the active mode. */
  sendModeKey: (key: ExtensionKeyEvent) => ExtensionKeyboardModeKeyResult;
}

/** Own the single extension keyboard mode active across one mounted review session. */
export function useKeyboardModeController({
  commands,
  createHighlightControls,
  cwd,
  modes,
  notify,
  registry,
  showNotice,
}: {
  commands: ExtensionCommandControls;
  /** Build live host-owned line-highlight controls for one extension. */
  createHighlightControls: (extensionId: string) => ExtensionLineHighlightControls;
  cwd: string;
  modes: readonly RegisteredKeyboardMode[];
  notify: ExtensionContext["notify"];
  registry: ExtensionRegistry | undefined;
  showNotice: (message: string) => void;
}): KeyboardModeController {
  const modesRef = useRef(modes);
  modesRef.current = modes;
  const createHighlightControlsRef = useRef(createHighlightControls);
  createHighlightControlsRef.current = createHighlightControls;
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const aliveRef = useRef(true);
  const lifecycleDepthRef = useRef(0);

  // The ref changes eagerly so several keys delivered in one input flush see entry and exit.
  const [activeMode, setActiveModeState] = useState<ActiveSessionKeyboardMode | null>(null);
  const activeModeRef = useRef<ActiveSessionKeyboardMode | null>(null);
  const setActiveMode = useCallback((next: ActiveSessionKeyboardMode | null) => {
    activeModeRef.current = next;
    setActiveModeState(next);
  }, []);
  const warnMode = useCallback((message: string) => notifyRef.current(message, "warning"), []);

  /** Run lifecycle code while ownership-changing controls are intentionally inert. */
  const runModeLifecycle = useCallback(
    (active: ActiveSessionKeyboardMode, phase: "onEnter" | "onExit") => {
      lifecycleDepthRef.current += 1;
      try {
        return runSessionKeyboardModeLifecycle(active, phase, warnMode);
      } finally {
        lifecycleDepthRef.current -= 1;
      }
    },
    [warnMode],
  );

  /**
   * Tear down the active mode exactly once before running extension lifecycle code.
   *
   * Lifecycle callbacks may observe their scoped state but cannot change keyboard ownership. This
   * keeps every replacement on the explicit command/onKey path and makes host teardown final.
   */
  const teardownMode = useCallback(() => {
    const active = activeModeRef.current;
    if (!active) return;
    setActiveMode(null);
    runModeLifecycle(active, "onExit");
  }, [runModeLifecycle, setActiveMode]);
  const exitMode = teardownMode;
  const exitModeRef = useRef(exitMode);
  exitModeRef.current = exitMode;

  /** Retire stale registry authority before answering a control or key-routing probe. */
  const getLiveActiveMode = useCallback(() => {
    const active = activeModeRef.current;
    if (active && !sessionKeyboardModeStillValid(active, registryRef.current, modesRef.current)) {
      exitModeRef.current();
      return null;
    }
    return active;
  }, []);

  const createControlsRef = useRef<
    (
      extensionId: string,
      owningRegistry: ExtensionRegistry | undefined,
      scope?: KeyboardModeControlScope,
    ) => ExtensionKeyboardModeControls
  >(() => {
    throw new Error("Keyboard mode controls are not ready");
  });

  /** Start one registration after tearing down the previous session mode. */
  const beginMode = useCallback(
    (
      extensionId: string,
      owningRegistry: ExtensionRegistry,
      registered: RegisteredKeyboardMode,
    ) => {
      exitMode();

      const scope: KeyboardModeControlScope = { active: null };
      const keyboardModes = createControlsRef.current(extensionId, owningRegistry, scope);
      const ctx: ExtensionKeyboardModeContext = Object.freeze({
        cwd: cwdRef.current,
        notify: (message: string, type?: ExtensionNotifyType) => notifyRef.current(message, type),
        commands: commandsRef.current,
        keyboardModes,
        highlights: createHighlightControlsRef.current(extensionId),
      });
      const active: ActiveSessionKeyboardMode = {
        ctx,
        extensionId,
        mode: registered.mode,
        modeId: registered.mode.id,
        registered,
        registry: owningRegistry,
      };
      scope.active = active;
      setActiveMode(active);
      if (!runModeLifecycle(active, "onEnter")) {
        if (activeModeRef.current === active) exitMode();
        return false;
      }

      return activeModeRef.current === active;
    },
    [exitMode, runModeLifecycle, setActiveMode],
  );

  /** Build live controls without capturing mode selection or active state. */
  const createControls = useCallback(
    (
      extensionId: string,
      owningRegistry: ExtensionRegistry | undefined,
      scope?: KeyboardModeControlScope,
    ): ExtensionKeyboardModeControls => {
      const hasAuthority = () =>
        aliveRef.current &&
        owningRegistry !== undefined &&
        owningRegistry.eventBusPhase !== "closed" &&
        registryRef.current === owningRegistry;
      const resolve = (modeId: string) =>
        modesRef.current.find(
          (registered) => registered.extensionId === extensionId && registered.mode.id === modeId,
        );
      const canChangeOwnership = () =>
        hasAuthority() &&
        lifecycleDepthRef.current === 0 &&
        (!scope || activeModeRef.current === scope.active);

      const controls: ExtensionKeyboardModeControls = {
        enterMode(modeId: string) {
          if (!owningRegistry || !canChangeOwnership()) return false;
          if (typeof modeId !== "string" || modeId.trim().length === 0) {
            showNotice(`Extension ${extensionId} targeted an invalid keyboard mode id`);
            return false;
          }
          const registered = resolve(modeId);
          if (!registered) {
            showNotice(`Extension ${extensionId} targeted unknown keyboard mode "${modeId}"`);
            return false;
          }
          return beginMode(extensionId, owningRegistry, registered);
        },
        exitMode() {
          if (!canChangeOwnership()) return false;
          const active = getLiveActiveMode();
          if (!active || active.extensionId !== extensionId || (scope && active !== scope.active)) {
            return false;
          }
          exitMode();
          return true;
        },
        isActive(modeId?: string) {
          if (!hasAuthority()) return false;
          if (modeId !== undefined && (typeof modeId !== "string" || modeId.length === 0)) {
            return false;
          }
          const active = getLiveActiveMode();
          return Boolean(
            active &&
            active.extensionId === extensionId &&
            (!scope || active === scope.active) &&
            (modeId === undefined || active.modeId === modeId),
          );
        },
      };
      return Object.freeze(controls);
    },
    [beginMode, exitMode, getLiveActiveMode, showNotice],
  );
  createControlsRef.current = createControls;

  /** Report synchronous ownership, retiring closed registry authority first. */
  const isModeActive = useCallback(() => getLiveActiveMode() !== null, [getLiveActiveMode]);

  /** Deliver a key without capturing a stale activation. */
  const sendModeKey = useCallback(
    (key: ExtensionKeyEvent): ExtensionKeyboardModeKeyResult => {
      const active = getLiveActiveMode();
      if (!active) return "pass";
      const result = deliverSessionKeyboardModeKey(active, key, warnMode);
      // A handler can enter a replacement. Its predecessor's exit answer cannot tear it down.
      return result === "exit" && activeModeRef.current !== active ? "handled" : result;
    },
    [getLiveActiveMode, warnMode],
  );

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      exitModeRef.current();
    };
  }, []);

  // Render-driven reconciliation handles replacement registrations even without a following key.
  useEffect(() => {
    getLiveActiveMode();
  }, [getLiveActiveMode, modes, registry]);

  return {
    createControls,
    isModeActive,
    modeStatusHint: activeMode ? sessionKeyboardModeStatusHint(activeMode) : null,
    activeModeTitle: activeMode ? sessionKeyboardModeDisplayTitle(activeMode) : null,
    exitMode,
    sendModeKey,
  };
}
