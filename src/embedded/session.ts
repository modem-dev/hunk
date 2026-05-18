import { loadAppBootstrap } from "../core/loaders";
import type { AppBootstrap } from "../core/types";
import {
  createInitialSessionSnapshot,
  createSessionRegistration,
  updateSessionRegistration,
} from "../hunk-session/sessionRegistration";
import type { HunkSessionBrokerClient } from "../hunk-session/types";
import { SessionBrokerClient } from "../session-broker/brokerClient";
import {
  embeddedHunkSourcesEqual,
  normalizeEmbeddedHunkSource,
  resolveEmbeddedCliInput,
} from "./source";
import type {
  CreateEmbeddedHunkSessionInput,
  EmbeddedHunkSession,
  EmbeddedHunkSnapshot,
  EmbeddedHunkSource,
} from "./types";

export type EmbeddedHunkRenderSnapshot =
  | { status: "loading"; source: EmbeddedHunkSource; bootstrap: AppBootstrap; error?: undefined }
  | { status: "ready"; source: EmbeddedHunkSource; bootstrap: AppBootstrap; error?: undefined }
  | { status: "error"; source: EmbeddedHunkSource; bootstrap: AppBootstrap; error: string };

/** Convert unknown thrown values into stable user-facing error text. */
function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "Failed to load Hunk.");
}

/** Build the host-facing embedded snapshot without exposing app bootstrap internals. */
function publicSnapshot(snapshot: EmbeddedHunkRenderSnapshot): EmbeddedHunkSnapshot {
  switch (snapshot.status) {
    case "loading":
      return { status: "loading", source: snapshot.source };
    case "ready":
      return {
        status: "ready",
        source: snapshot.source,
        title: snapshot.bootstrap.changeset.title,
        fileCount: snapshot.bootstrap.changeset.files.length,
      };
    case "error":
      return {
        status: "error",
        source: snapshot.source,
        title: snapshot.bootstrap.changeset.title,
        fileCount: snapshot.bootstrap.changeset.files.length,
        error: snapshot.error,
      };
  }
}

/** Own one embedded Hunk review session, including source identity and broker registration. */
class EmbeddedHunkSessionImpl implements EmbeddedHunkSession {
  private listeners = new Set<() => void>();
  private disposed = false;
  private renderSnapshot: EmbeddedHunkRenderSnapshot;
  private snapshot: EmbeddedHunkSnapshot;

  readonly hostClient: HunkSessionBrokerClient;

  constructor(
    readonly cwd: string,
    public source: EmbeddedHunkSource,
    bootstrap: AppBootstrap,
  ) {
    this.renderSnapshot = { status: "ready", source, bootstrap };
    this.snapshot = publicSnapshot(this.renderSnapshot);
    this.hostClient = new SessionBrokerClient(
      createSessionRegistration(bootstrap, { cwd }),
      createInitialSessionSnapshot(bootstrap),
    );
    this.hostClient.start();
  }

  getSnapshot = () => this.snapshot;

  getRenderSnapshot = () => this.renderSnapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async open(source: EmbeddedHunkSource) {
    const nextSource = normalizeEmbeddedHunkSource(source);
    if (this.disposed || embeddedHunkSourcesEqual(this.source, nextSource)) return;
    await this.load(nextSource, { updateSource: true });
  }

  async reload() {
    if (this.disposed) return;
    await this.load(this.source, { updateSource: false });
  }

  dispose() {
    this.disposed = true;
    this.hostClient.stop();
    this.listeners.clear();
  }

  private async load(source: EmbeddedHunkSource, { updateSource }: { updateSource: boolean }) {
    this.setRenderSnapshot({
      status: "loading",
      source: this.source,
      bootstrap: this.renderSnapshot.bootstrap,
    });

    try {
      const bootstrap = await loadAppBootstrap(resolveEmbeddedCliInput(source, this.cwd), {
        cwd: this.cwd,
      });
      if (updateSource) {
        this.source = source;
      }
      this.hostClient.replaceSession(
        updateSessionRegistration(this.hostClient.getRegistration(), bootstrap),
        createInitialSessionSnapshot(bootstrap),
      );
      this.setRenderSnapshot({ status: "ready", source: this.source, bootstrap });
    } catch (error) {
      const message = errorMessage(error);
      this.setRenderSnapshot({
        status: "error",
        source: this.source,
        bootstrap: this.renderSnapshot.bootstrap,
        error: message,
      });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  private setRenderSnapshot(snapshot: EmbeddedHunkRenderSnapshot) {
    this.renderSnapshot = snapshot;
    this.snapshot = publicSnapshot(snapshot);
    for (const listener of this.listeners) listener();
  }
}

/** Resolve private render state for sessions created by this embedded entrypoint. */
export function embeddedHunkSessionInternals(session: EmbeddedHunkSession) {
  if (session instanceof EmbeddedHunkSessionImpl) {
    return {
      getRenderSnapshot: session.getRenderSnapshot,
      hostClient: session.hostClient,
    };
  }
  throw new Error("mountEmbeddedHunkApp requires a session from createEmbeddedHunkSession.");
}

/** Create one embedded Hunk review session from a public embedded source. */
export async function createEmbeddedHunkSession({
  cwd = process.cwd(),
  source,
}: CreateEmbeddedHunkSessionInput): Promise<EmbeddedHunkSession> {
  const normalizedSource = normalizeEmbeddedHunkSource(source);
  const bootstrap = await loadAppBootstrap(resolveEmbeddedCliInput(normalizedSource, cwd), { cwd });
  return new EmbeddedHunkSessionImpl(cwd, normalizedSource, bootstrap);
}
