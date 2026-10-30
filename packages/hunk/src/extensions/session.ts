import { emitExtensionEvent, retireExtensionLoadResult } from "./events";
import type { ExtensionLoadResult, ExtensionRegistry } from "./types";

/** Owns extension registries for one command or interactive Hunk session. */
export interface ExtensionSession {
  readonly current: ExtensionLoadResult;
  readonly cwd: string;
  readonly closing: boolean;
  startCurrent(cwd?: string): boolean;
  trackPrepared(result: ExtensionLoadResult): void;
  retirePrepared(result?: ExtensionLoadResult): Promise<void>;
  adoptPrepared(result: ExtensionLoadResult, cwd: string): Promise<void>;
  shutdown(): Promise<void>;
}

/** Coordinates active, provisional, and retiring extension registries by registry identity. */
class ExtensionSessionImpl implements ExtensionSession {
  #current: ExtensionLoadResult;
  #cwd: string;
  #closing = false;
  #prepared = new Map<ExtensionRegistry, ExtensionLoadResult>();
  #started = new WeakSet<ExtensionRegistry>();
  #retirements = new Set<Promise<void>>();
  #shutdownPromise: Promise<void> | undefined;

  constructor(initial: ExtensionLoadResult, cwd: string) {
    this.#current = initial;
    this.#cwd = cwd;
  }

  get current() {
    return this.#current;
  }

  get cwd() {
    return this.#cwd;
  }

  get closing() {
    return this.#closing;
  }

  /** Emit startup once for each registry that reaches active authority. */
  startCurrent(cwd = this.#cwd) {
    if (this.#closing) return false;
    const { registry } = this.#current;
    if (this.#started.has(registry)) return false;
    this.#started.add(registry);
    emitExtensionEvent(this.#current, "startup", { cwd });
    return true;
  }

  /** Own a provisional registry before asynchronous loading can suspend. */
  trackPrepared(result: ExtensionLoadResult) {
    if (result.registry === this.#current.registry) return;
    if (this.#closing) {
      void this.#retire(result);
      return;
    }
    this.#prepared.set(result.registry, result);
  }

  /** Retire one staged registry, or every registry that has not been adopted. */
  async retirePrepared(result?: ExtensionLoadResult) {
    if (result) {
      if (result.registry === this.#current.registry) return;
      this.#prepared.delete(result.registry);
      await this.#retire(result);
      return;
    }
    const prepared = [...this.#prepared.values()];
    this.#prepared.clear();
    await Promise.allSettled(prepared.map((entry) => this.#retire(entry)));
  }

  /** Adopt a staged registry at the caller's content commit gate and retire its predecessor. */
  adoptPrepared(result: ExtensionLoadResult, cwd: string) {
    if (this.#closing) throw new Error("The extension session is shutting down.");
    if (result.registry !== this.#current.registry && !this.#prepared.has(result.registry)) {
      throw new Error("The extension registry was not prepared by this session.");
    }
    if (result.registry === this.#current.registry) {
      this.#cwd = cwd;
      return Promise.resolve();
    }

    const previous = this.#current;
    this.#prepared.delete(result.registry);
    // Retirement revokes the old event/control authority synchronously before the swap is visible.
    const retirement = this.#retire(previous);
    this.#current = result;
    this.#cwd = cwd;
    return retirement;
  }

  /** Revoke every owned registry and wait for all retirement work known to this call. */
  shutdown() {
    if (!this.#closing) {
      this.#closing = true;
      void this.#retire(this.#current);
      const prepared = [...this.#prepared.values()];
      this.#prepared.clear();
      for (const result of prepared) void this.#retire(result);
    }

    const previous = this.#shutdownPromise;
    const shutdown = (async () => {
      await previous;
      while (this.#retirements.size > 0) {
        await Promise.allSettled(this.#retirements);
      }
    })();
    this.#shutdownPromise = shutdown;
    return shutdown;
  }

  /** Track one registry's shared retirement completion without duplicating shutdown. */
  #retire(result: ExtensionLoadResult) {
    const retirement = retireExtensionLoadResult(result);
    this.#retirements.add(retirement);
    void retirement.then(
      () => this.#retirements.delete(retirement),
      () => this.#retirements.delete(retirement),
    );
    return retirement;
  }
}

/** Create one explicit owner for a loaded extension registry. */
export function createExtensionSession(
  initial: ExtensionLoadResult,
  cwd: string,
): ExtensionSession {
  return new ExtensionSessionImpl(initial, cwd);
}
