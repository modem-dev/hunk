import { isDeepStrictEqual } from "node:util";
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
import { createEmbeddedSessionBrokerAvailability } from "./daemon";
import type {
  CreateEmbeddedHunkSessionInput,
  EmbeddedHunkSession,
  EmbeddedHunkSnapshot,
  EmbeddedHunkSource,
} from "./types";

export type EmbeddedHunkRenderSnapshot =
  | { status: "loading"; bootstrap: AppBootstrap; error?: undefined }
  | { status: "ready"; bootstrap: AppBootstrap; error?: undefined }
  | { status: "error"; bootstrap: AppBootstrap; error: string };

type NormalizedEmbeddedHunkSource = EmbeddedHunkSource & { options: CommonOptions };

/** Drop undefined option entries so equivalent embedded sources compare the same. */
function normalizeEmbeddedOptions(options: EmbeddedHunkSource["options"] = {}): CommonOptions {
  const normalized = { ...options };
  for (const key of Object.keys(normalized) as Array<keyof typeof normalized>) {
    if (normalized[key] === undefined) delete normalized[key];
  }
  return normalized;
}

/** Return a session-owned source copy with normalized options and pathspec identity. */
function normalizeEmbeddedHunkSource(source: EmbeddedHunkSource): NormalizedEmbeddedHunkSource {
  const normalized = {
    ...source,
    options: normalizeEmbeddedOptions(source.options),
  } as NormalizedEmbeddedHunkSource;

  if ("pathspecs" in normalized) {
    if (normalized.pathspecs === undefined) {
      delete normalized.pathspecs;
    } else {
      normalized.pathspecs = [...normalized.pathspecs];
    }
  }

  return normalized;
}

/** Adapt a public embedded source into the internal CLI input pipeline. */
function embeddedSourceToCliInput(source: EmbeddedHunkSource): CliInput {
  const normalized = normalizeEmbeddedHunkSource(source);

  switch (normalized.kind) {
    case "worktree":
      return {
        kind: "vcs",
        staged: false,
        pathspecs: normalized.pathspecs,
        options: normalized.options,
      };
    case "staged":
      return {
        kind: "vcs",
        staged: true,
        pathspecs: normalized.pathspecs,
        options: normalized.options,
      };
    case "patch":
      return {
        kind: "patch",
        text: normalized.text,
        file: normalized.file ?? normalized.label,
        options: normalized.options,
      };
    default:
      return normalized as CliInput;
  }
}

/** Resolve embedded input through the same config layers as the CLI. */
function resolveEmbeddedCliInput(source: EmbeddedHunkSource, cwd: string) {
  return resolveConfiguredCliInput(embeddedSourceToCliInput(source), { cwd }).input;
}

/** Build the host-facing embedded snapshot without exposing app bootstrap internals. */
function publicSnapshot(
  source: EmbeddedHunkSource,
  snapshot: EmbeddedHunkRenderSnapshot,
): EmbeddedHunkSnapshot {
  if (snapshot.status === "loading") {
    return { status: "loading", source };
  }

  const base = {
    source,
    title: snapshot.bootstrap.changeset.title,
    fileCount: snapshot.bootstrap.changeset.files.length,
  };
  return snapshot.status === "error"
    ? { ...base, status: "error", error: snapshot.error }
    : { ...base, status: "ready" };
}

/** Own one embedded Hunk review session, including source identity and broker registration. */
class EmbeddedHunkSessionImpl implements EmbeddedHunkSession {
  private listeners = new Set<() => void>();
  private disposed = false;
  private renderSnapshot: EmbeddedHunkRenderSnapshot;

  readonly hostClient: HunkSessionBrokerClient;

  constructor(
    readonly cwd: string,
    public source: EmbeddedHunkSource,
    bootstrap: AppBootstrap,
  ) {
    this.renderSnapshot = { status: "ready", bootstrap };
    this.hostClient = new SessionBrokerClient(
      createSessionRegistration(bootstrap, { cwd }),
      createInitialSessionSnapshot(bootstrap),
      {
        ensureBrokerAvailable: createEmbeddedSessionBrokerAvailability({ cwd }),
      },
    );
    this.hostClient.start();
  }

  getSnapshot = () => publicSnapshot(this.source, this.renderSnapshot);

  getRenderSnapshot = () => this.renderSnapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Open a source idempotently; callers can re-open without learning source identity rules. */
  async open(source: EmbeddedHunkSource) {
    const nextSource = normalizeEmbeddedHunkSource(source);
    if (this.disposed || isDeepStrictEqual(normalizeEmbeddedHunkSource(this.source), nextSource)) {
      return this.getSnapshot();
    }
    return this.load(nextSource, { updateSource: true });
  }

  /** Reload the currently loaded source, preserving source identity for the host. */
  async reload() {
    if (this.disposed) return this.getSnapshot();
    return this.load(this.source, { updateSource: false });
  }

  dispose() {
    this.disposed = true;
    this.hostClient.stop();
    this.listeners.clear();
  }

  private async load(
    source: EmbeddedHunkSource,
    { updateSource }: { updateSource: boolean },
  ): Promise<EmbeddedHunkSnapshot> {
    this.setRenderSnapshot({
      status: "loading",
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
      this.setRenderSnapshot({ status: "ready", bootstrap });
      return this.getSnapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setRenderSnapshot({
        status: "error",
        bootstrap: this.renderSnapshot.bootstrap,
        error: message,
      });
      throw error;
    }
  }

  private setRenderSnapshot(snapshot: EmbeddedHunkRenderSnapshot) {
    this.renderSnapshot = snapshot;
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
