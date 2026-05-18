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

/** Scope the renderer root and input stream to the host-provided embedded container. */
function scopedRenderer(
  renderer: CliRenderer,
  root: Renderable,
  keyInput: CliRenderer["keyInput"],
) {
  const scoped = Object.create(renderer) as CliRenderer;
  Object.defineProperty(scoped, "root", { value: root });
  Object.defineProperty(scoped, "keyInput", { value: keyInput });
  Object.defineProperty(scoped, "intermediateRender", {
    value() {
      if (!renderer.isDestroyed) renderer.requestRender();
    },
  });
  return scoped;
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
  const scopedKeyInput = createScopedKeyInput(renderer.keyInput, () => currentActive);
  const root = createRoot(scopedRenderer(renderer, container, scopedKeyInput.keyInput));

  const render = (next: { active: boolean; onQuit: () => void }) => {
    currentActive = next.active;
    root.render(<EmbeddedHunkRoot onQuit={next.onQuit} session={session} />);
  };

  render({ active, onQuit });

  return {
    update: render,
    unmount() {
      root.unmount();
      scopedKeyInput.dispose();
    },
  };
}
