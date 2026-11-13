import { useEffect, useRef } from "react";
import { startInputWatch, type WatchedInputRuntime } from "../../core/watch/inputWatch";
import type { ReloadContext } from "../../core/bootstrap";
import type { CliInput } from "../../core/run/commandInputs";

export type { WatchedInputRuntime };

const defaultRuntime: WatchedInputRuntime = {};

/** Arm the shared input watch for the mounted input and re-arm it when the input changes. */
export function useWatchedInput({
  enabled,
  input,
  reloadContext,
  onReloadPending,
  refresh,
  runtime = defaultRuntime,
}: {
  enabled: boolean;
  input: CliInput;
  onReloadPending?: () => void;
  reloadContext: ReloadContext;
  refresh: () => void | Promise<void>;
  runtime?: WatchedInputRuntime;
}) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const pendingRef = useRef(onReloadPending);
  pendingRef.current = onReloadPending;

  useEffect(() => {
    if (!enabled) return;

    const watch = startInputWatch({
      input,
      reloadContext,
      onReloadPending: () => pendingRef.current?.(),
      refresh: () => refreshRef.current(),
      runtime,
    });
    return () => watch?.close();
  }, [enabled, input, reloadContext, runtime]);
}
