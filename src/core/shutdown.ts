/** Minimal root contract needed for app shutdown. */
export interface ShutdownRoot {
  unmount: () => void;
}

/** Minimal renderer contract needed for app shutdown. */
export interface ShutdownRenderer {
  destroy: () => void;
}

/**
 * Tear down the TUI session and let the renderer restore the previous terminal screen.
 * The caller owns any once-only guard around this helper.
 */
export function shutdownSession({
  root,
  renderer,
  exit = (code: number) => process.exit(code),
}: {
  root: ShutdownRoot;
  renderer: ShutdownRenderer;
  exit?: (code: number) => never | void;
}) {
  let firstError: unknown;
  let hasError = false;
  /** Attempt every cleanup owner while retaining the first failure for deterministic reporting. */
  const attempt = (cleanup: () => void) => {
    try {
      cleanup();
    } catch (error) {
      if (!hasError) firstError = error;
      hasError = true;
    }
  };

  attempt(() => root.unmount());
  attempt(() => renderer.destroy());
  attempt(() => exit(0));
  if (hasError) throw firstError;
}
