import type { CliRenderer } from "@opentui/core";
import { useCallback, useMemo } from "react";
import type { ExtensionCommandContext } from "../../extension-api/types";
import type { ExtensionCapabilityLease } from "../lib/extensionCapabilityLease";

/** The terminal handoff capability installed on one extension command context. */
export type ExtensionOpenInApp = ExtensionCommandContext["openInApp"];

const activeAppByRenderer = new WeakMap<object, object>();

/** Build command-scoped app handoffs around one renderer's terminal ownership. */
export function useExtensionAppController({
  createReviewCapabilityLease,
  renderer,
}: {
  createReviewCapabilityLease: () => ExtensionCapabilityLease;
  renderer: Pick<CliRenderer, "suspend" | "resume" | "isDestroyed">;
}) {
  const createOpenInApp = useCallback((): ExtensionOpenInApp => {
    const lease = createReviewCapabilityLease();
    return async <Result>(run: () => Result | PromiseLike<Result>): Promise<Result> => {
      if (typeof run !== "function") {
        throw new Error("openInApp requires an application callback.");
      }
      if (!lease.isLive()) {
        throw new Error("openInApp is unavailable after the review reloads.");
      }
      if (activeAppByRenderer.has(renderer)) {
        throw new Error("openInApp is unavailable while another application owns the terminal.");
      }

      const ownership = {};
      activeAppByRenderer.set(renderer, ownership);
      let suspended = false;
      try {
        renderer.suspend();
        suspended = true;
        return await run();
      } finally {
        const stillOwnsTerminal = activeAppByRenderer.get(renderer) === ownership;
        if (stillOwnsTerminal) activeAppByRenderer.delete(renderer);
        if (stillOwnsTerminal && suspended && !renderer.isDestroyed) {
          try {
            renderer.resume();
          } catch (error) {
            console.error("Failed to restore Hunk after an extension application.", error);
          }
        }
      }
    };
  }, [createReviewCapabilityLease, renderer]);

  return useMemo(() => ({ createOpenInApp }), [createOpenInApp]);
}
