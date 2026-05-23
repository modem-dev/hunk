import type { CliRenderer, Renderable } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useSyncExternalStore } from "react";
import { AppHost } from "../ui/AppHost";
import { embeddedHunkSessionInternals } from "./session";
import type { EmbeddedHunkMount, EmbeddedHunkSession, MountEmbeddedHunkAppInput } from "./types";

const scopedKeyInputEvents = ["keypress", "keyrelease", "paste"] as const;

type ScopedKeyInputEvent = (typeof scopedKeyInputEvents)[number];
type KeyInputListener = (...args: unknown[]) => void;
type KeyInputSource = Readonly<{
  on: (event: string, listener: KeyInputListener) => unknown;
  off: (event: string, listener: KeyInputListener) => unknown;
}>;
type RendererListener = (...args: unknown[]) => void;
type ScopedRendererScope = {
  renderer: CliRenderer;
  dispose(): void;
};

/** Scope Hunk keyboard and paste listeners so inactive embedded mounts stay alive but quiet. */
export function createScopedKeyInput(source: KeyInputSource, enabled: () => boolean) {
  const listeners = new Map<ScopedKeyInputEvent, Set<KeyInputListener>>();
  const forwarders = new Map<ScopedKeyInputEvent, KeyInputListener>();

  for (const event of scopedKeyInputEvents) {
    listeners.set(event, new Set());
    forwarders.set(event, (...args: unknown[]) => {
      if (!enabled()) return;
      for (const listener of listeners.get(event) ?? []) listener(...args);
    });
  }

  const scoped = {
    on(event: string, listener: KeyInputListener) {
      if (!scopedKeyInputEvents.includes(event as ScopedKeyInputEvent)) {
        source.on(event, listener);
        return scoped;
      }

      const scopedEvent = event as ScopedKeyInputEvent;
      const eventListeners = listeners.get(scopedEvent)!;
      if (eventListeners.size === 0) source.on(scopedEvent, forwarders.get(scopedEvent)!);
      eventListeners.add(listener);
      return scoped;
    },
    off(event: string, listener: KeyInputListener) {
      if (!scopedKeyInputEvents.includes(event as ScopedKeyInputEvent)) {
        source.off(event, listener);
        return scoped;
      }

      const scopedEvent = event as ScopedKeyInputEvent;
      const eventListeners = listeners.get(scopedEvent)!;
      eventListeners.delete(listener);
      if (eventListeners.size === 0) source.off(scopedEvent, forwarders.get(scopedEvent)!);
      return scoped;
    },
  };

  return {
    keyInput: scoped as CliRenderer["keyInput"],
    dispose() {
      for (const event of scopedKeyInputEvents) {
        const forwarder = forwarders.get(event);
        if (forwarder) source.off(event, forwarder);
        listeners.get(event)?.clear();
      }
    },
  };
}

/** Scope renderer APIs that embedded Hunk reads to the host-provided container. */
export function createEmbeddedRendererScope(
  renderer: CliRenderer,
  root: Renderable,
  keyInput: CliRenderer["keyInput"],
  active: () => boolean = () => true,
): ScopedRendererScope {
  const scoped = Object.create(renderer) as CliRenderer;
  const resizeListeners = new Set<RendererListener>();
  let embeddedCursor: { x: number; y: number; visible: boolean } | undefined;
  let wasActive = active();
  const readWidth = () => Math.max(1, root.width);
  const readHeight = () => Math.max(1, root.height);
  const emitResize = () => {
    for (const listener of resizeListeners) listener(readWidth(), readHeight());
  };
  const hideHostCursor = () => renderer.setCursorPosition(0, 0, false);
  const enforceCursorScope: Parameters<CliRenderer["addPostProcessFn"]>[0] = () => {
    const isActive = active();
    if (isActive) {
      if (embeddedCursor?.visible)
        renderer.setCursorPosition(embeddedCursor.x, embeddedCursor.y, true);
      else hideHostCursor();
    } else if (wasActive) {
      hideHostCursor();
    }

    embeddedCursor = undefined;
    wasActive = isActive;
  };

  root.on("resize", emitResize);
  renderer.addPostProcessFn(enforceCursorScope);

  Object.defineProperties(scoped, {
    height: { get: readHeight },
    intermediateRender: {
      value() {
        if (!renderer.isDestroyed) renderer.requestRender();
      },
    },
    keyInput: { value: keyInput },
    setCursorPosition: {
      value(x: number, y: number, visible = true) {
        if (!active()) {
          embeddedCursor = undefined;
          return;
        }

        embeddedCursor = { x, y, visible };
        renderer.setCursorPosition(x, y, visible);
      },
    },
    off: {
      value(event: string | symbol, listener: RendererListener) {
        if (event === "resize") {
          resizeListeners.delete(listener);
          return scoped;
        }

        renderer.off(event, listener);
        return scoped;
      },
    },
    on: {
      value(event: string | symbol, listener: RendererListener) {
        if (event === "resize") {
          resizeListeners.add(listener);
          return scoped;
        }

        renderer.on(event, listener);
        return scoped;
      },
    },
    root: { value: root },
    terminalHeight: { get: readHeight },
    terminalWidth: { get: readWidth },
    width: { get: readWidth },
  });

  return {
    renderer: scoped,
    dispose() {
      root.off("resize", emitResize);
      renderer.removePostProcessFn(enforceCursorScope);
      resizeListeners.clear();
    },
  };
}

function EmbeddedHunkRoot({
  onQuit,
  session,
}: {
  onQuit: () => void;
  session: EmbeddedHunkSession;
}) {
  const internals = embeddedHunkSessionInternals(session);
  const snapshot = useSyncExternalStore(
    session.subscribe,
    internals.getRenderSnapshot,
    internals.getRenderSnapshot,
  );

  return (
    <AppHost
      bootstrap={snapshot.bootstrap}
      hostClient={internals.hostClient}
      initialSessionState={internals.getSessionSnapshot().state}
      onSessionReloaded={({ bootstrap, snapshot }) =>
        internals.syncMountedReload(bootstrap, snapshot)
      }
      onQuit={onQuit}
      startupNoticeResolver={async () => null}
    />
  );
}

/** Mount one embedded Hunk app into a host-owned OpenTUI container. */
export function mountEmbeddedHunkApp({
  active,
  container,
  onQuit,
  renderer,
  session,
}: MountEmbeddedHunkAppInput): EmbeddedHunkMount {
  let currentActive = active;
  let currentOnQuit = onQuit;
  const handleQuit = () => currentOnQuit();
  const scopedKeyInput = createScopedKeyInput(renderer.keyInput, () => currentActive);
  const scopedRenderer = createEmbeddedRendererScope(
    renderer,
    container,
    scopedKeyInput.keyInput,
    () => currentActive,
  );
  const root = createRoot(scopedRenderer.renderer);

  // Keep one React root mounted; repeated root.render calls leave sibling OpenTUI trees behind.
  root.render(<EmbeddedHunkRoot onQuit={handleQuit} session={session} />);

  return {
    update(next) {
      currentActive = next.active;
      currentOnQuit = next.onQuit;
      if (!renderer.isDestroyed) renderer.requestRender();
    },
    unmount() {
      root.unmount();
      scopedRenderer.dispose();
      scopedKeyInput.dispose();
    },
  };
}
