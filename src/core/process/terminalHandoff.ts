const HANDOFF_ENV = "HUNK_TERMINAL_HANDOFF";
const HANDOFF_THEME_MODE_ENV = "HUNK_TERMINAL_HANDOFF_THEME_MODE";
const PROTOCOL = "hunk-terminal-handoff-v1";

export type TerminalHandoffMessage =
  | { protocol: typeof PROTOCOL; kind: "ready" }
  | { protocol: typeof PROTOCOL; kind: "release" }
  | { protocol: typeof PROTOCOL; kind: "failed"; message: string };

/** Return whether this process was launched for a coordinated terminal handoff. */
export function hasTerminalHandoff(env: NodeJS.ProcessEnv = process.env) {
  return env[HANDOFF_ENV] === "1";
}

/** Read the parent's already-detected terminal mode without querying the owned terminal again. */
export function terminalHandoffThemeMode(
  env: NodeJS.ProcessEnv = process.env,
): "dark" | "light" | undefined {
  if (!hasTerminalHandoff(env)) return undefined;
  const value = env[HANDOFF_THEME_MODE_ENV];
  return value === "dark" || value === "light" ? value : undefined;
}

/** Add the private one-shot handoff marker and terminal mode to a child environment. */
export function terminalHandoffEnv(
  env: NodeJS.ProcessEnv,
  themeMode: "dark" | "light" | undefined,
): NodeJS.ProcessEnv {
  return {
    ...env,
    [HANDOFF_ENV]: "1",
    ...(themeMode ? { [HANDOFF_THEME_MODE_ENV]: themeMode } : {}),
  };
}

/** Narrow an IPC payload to one bounded handoff protocol message. */
export function parseTerminalHandoffMessage(value: unknown): TerminalHandoffMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as Record<string, unknown>;
  if (message.protocol !== PROTOCOL) return undefined;
  if (message.kind === "ready" || message.kind === "release") {
    return { protocol: PROTOCOL, kind: message.kind };
  }
  if (message.kind === "failed" && typeof message.message === "string") {
    return { protocol: PROTOCOL, kind: "failed", message: message.message.slice(0, 2_000) };
  }
  return undefined;
}

/** Build one authenticated-by-inheritance IPC message for the handoff peer. */
export function terminalHandoffMessage(kind: "ready" | "release"): TerminalHandoffMessage {
  return { protocol: PROTOCOL, kind };
}

/** Tell the parent startup succeeded, then wait boundedly for exclusive terminal ownership. */
export async function awaitTerminalHandoffRelease({
  env = process.env,
  timeoutMs = 10_000,
}: {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
} = {}) {
  if (!hasTerminalHandoff(env)) return;
  if (typeof process.send !== "function" || !process.connected) {
    throw new Error("The terminal handoff channel is unavailable.");
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (value: unknown) => {
      const message = parseTerminalHandoffMessage(value);
      if (message?.kind === "release") finish();
    };
    const onDisconnect = () => finish(new Error("The terminal handoff parent disconnected."));
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for terminal ownership.")),
      timeoutMs,
    );
    timeout.unref?.();
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    process.send!(terminalHandoffMessage("ready"), (error) => {
      if (error) finish(error);
    });
  });
  process.disconnect?.();
  delete env[HANDOFF_ENV];
  delete env[HANDOFF_THEME_MODE_ENV];
}

/** Report a bounded pre-render startup failure to a waiting parent. */
export async function reportTerminalHandoffFailure(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!hasTerminalHandoff(env) || typeof process.send !== "function" || !process.connected) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  await new Promise<void>((resolve) => {
    process.send!({ protocol: PROTOCOL, kind: "failed", message: message.slice(0, 2_000) }, () =>
      resolve(),
    );
  });
  process.disconnect?.();
  return true;
}
