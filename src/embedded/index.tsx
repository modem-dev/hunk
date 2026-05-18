import type { CliRenderer, Renderable } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useSyncExternalStore } from "react";
import { resolveConfiguredCliInput } from "../core/config";
import { loadAppBootstrap } from "../core/loaders";
import type { AppBootstrap, CliInput, CommonOptions } from "../core/types";
import {
  createInitialSessionSnapshot,
  createSessionRegistration,
  updateSessionRegistration,
} from "../hunk-session/sessionRegistration";
import type { HunkSessionBrokerClient } from "../hunk-session/types";
import { SessionBrokerClient } from "../session-broker/brokerClient";
import { AppHost } from "../ui/AppHost";

export type EmbeddedHunkSource =
  | { kind: "worktree"; pathspecs?: string[]; options?: CommonOptions }
  | { kind: "staged"; pathspecs?: string[]; options?: CommonOptions }
  | {
      kind: "vcs";
      range?: string;
      staged: boolean;
      pathspecs?: string[];
      options?: CommonOptions;
    }
  | { kind: "show"; ref?: string; pathspecs?: string[]; options?: CommonOptions }
  | { kind: "stash-show"; ref?: string; options?: CommonOptions }
  | { kind: "diff"; left: string; right: string; options?: CommonOptions }
  | { kind: "patch"; file?: string; text?: string; label?: string; options?: CommonOptions }
  | { kind: "difftool"; left: string; right: string; path?: string; options?: CommonOptions };

export type EmbeddedHunkSnapshot =
  | { status: "loading"; bootstrap: AppBootstrap; error?: undefined }
  | { status: "ready"; bootstrap: AppBootstrap; error?: undefined }
  | { status: "error"; bootstrap: AppBootstrap; error: string };

export interface EmbeddedHunkSession {
  readonly cwd: string;
  readonly source: EmbeddedHunkSource;
  getSnapshot(): EmbeddedHunkSnapshot;
  load(source: EmbeddedHunkSource): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface EmbeddedHunkMount {
  update(options: { active: boolean; onQuit: () => void }): void;
  unmount(): void;
}

function embeddedSourceToCliInput(source: EmbeddedHunkSource): CliInput {
  const options = source.options ?? {};

  switch (source.kind) {
    case "worktree":
      return {
        kind: "vcs",
        staged: false,
        pathspecs: source.pathspecs,
        options,
      };
    case "staged":
      return {
        kind: "vcs",
        staged: true,
        pathspecs: source.pathspecs,
        options,
      };
    case "patch":
      return {
        kind: "patch",
        text: source.text,
        file: source.file ?? source.label,
        options,
      };
    default:
      return { ...source, options } as CliInput;
  }
}

function resolveEmbeddedCliInput(source: EmbeddedHunkSource, cwd: string) {
  return resolveConfiguredCliInput(embeddedSourceToCliInput(source), { cwd }).input;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "Failed to load Hunk.");
}

class EmbeddedHunkSessionImpl implements EmbeddedHunkSession {
  private listeners = new Set<() => void>();
  private disposed = false;
  private snapshot: EmbeddedHunkSnapshot;

  readonly hostClient: HunkSessionBrokerClient;

  constructor(
    readonly cwd: string,
    public source: EmbeddedHunkSource,
    bootstrap: AppBootstrap,
  ) {
    this.snapshot = { status: "ready", bootstrap };
    this.hostClient = new SessionBrokerClient(
      createSessionRegistration(bootstrap, { cwd }),
      createInitialSessionSnapshot(bootstrap),
    );
    this.hostClient.start();
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async load(source: EmbeddedHunkSource) {
    if (this.disposed) return;
    this.setSnapshot({ status: "loading", bootstrap: this.snapshot.bootstrap });

    try {
      const bootstrap = await loadAppBootstrap(resolveEmbeddedCliInput(source, this.cwd), {
        cwd: this.cwd,
      });
      this.source = source;
      this.hostClient.replaceSession(
        updateSessionRegistration(this.hostClient.getRegistration(), bootstrap),
        createInitialSessionSnapshot(bootstrap),
      );
      this.setSnapshot({ status: "ready", bootstrap });
    } catch (error) {
      const message = errorMessage(error);
      this.setSnapshot({
        status: "error",
        bootstrap: this.snapshot.bootstrap,
        error: message,
      });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  dispose() {
    this.disposed = true;
    this.hostClient.stop();
    this.listeners.clear();
  }

  private setSnapshot(snapshot: EmbeddedHunkSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

/** Resolve the internal broker client owned by sessions created through this entrypoint. */
function sessionHostClient(session: EmbeddedHunkSession) {
  if (session instanceof EmbeddedHunkSessionImpl) {
    return session.hostClient;
  }
  throw new Error("mountEmbeddedHunkApp requires a session from createEmbeddedHunkSession.");
}

function EmbeddedHunkRoot({
  active,
  onQuit,
  session,
}: {
  active: boolean;
  onQuit: () => void;
  session: EmbeddedHunkSession;
}) {
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );

  return (
    <AppHost
      active={active}
      bootstrap={snapshot.bootstrap}
      hostClient={sessionHostClient(session)}
      onQuit={onQuit}
      startupNoticeResolver={async () => null}
    />
  );
}

function scopedRenderer(renderer: CliRenderer, root: Renderable) {
  const scoped = Object.create(renderer) as CliRenderer;
  Object.defineProperty(scoped, "root", { value: root });
  return scoped;
}

export async function createEmbeddedHunkSession({
  cwd = process.cwd(),
  source,
}: {
  cwd?: string;
  source: EmbeddedHunkSource;
}): Promise<EmbeddedHunkSession> {
  const bootstrap = await loadAppBootstrap(resolveEmbeddedCliInput(source, cwd), { cwd });
  return new EmbeddedHunkSessionImpl(cwd, source, bootstrap);
}

export function mountEmbeddedHunkApp({
  active,
  container,
  onQuit,
  renderer,
  session,
}: {
  active: boolean;
  container: Renderable;
  onQuit: () => void;
  renderer: CliRenderer;
  session: EmbeddedHunkSession;
}): EmbeddedHunkMount {
  const root = createRoot(scopedRenderer(renderer, container));

  const render = (next: { active: boolean; onQuit: () => void }) => {
    root.render(<EmbeddedHunkRoot active={next.active} onQuit={next.onQuit} session={session} />);
  };

  render({ active, onQuit });

  return {
    update: render,
    unmount() {
      root.unmount();
    },
  };
}
