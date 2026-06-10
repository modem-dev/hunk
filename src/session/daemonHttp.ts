import { HunkUserError } from "../core/errors";
import {
  resolveSessionBrokerConfig,
  type ResolvedSessionBrokerConfig,
} from "../session-broker/brokerConfig";

export const HUNK_SESSION_DAEMON_HTTP_TIMEOUT_MS = 5_000;

function createTimeoutError(operation: string, timeoutMs: number) {
  return new HunkUserError(`Timed out waiting for the Hunk session daemon to ${operation}.`, [
    `The daemon did not respond within ${timeoutMs}ms.`,
    'Run "hunk daemon serve" or open a Hunk window, then retry.',
  ]);
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Run one daemon HTTP operation with a timeout that covers connect, headers, and body parsing. */
export async function withSessionDaemonHttpTimeout<ResultType>({
  operation,
  timeoutMs = HUNK_SESSION_DAEMON_HTTP_TIMEOUT_MS,
  task,
}: {
  operation: string;
  timeoutMs?: number;
  task: (signal: AbortSignal) => Promise<ResultType>;
}) {
  const controller = new AbortController();
  const timeoutError = createTimeoutError(operation, timeoutMs);
  let timeoutTriggered = false;
  let timeout: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    // Keep this timer referenced: Bun 1.3.x on Windows can skip unref'ed timeout guards,
    // which leaves CLI requests and tests hung forever.
    timeout = setTimeout(() => {
      timeoutTriggered = true;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const taskPromise = task(controller.signal);

  try {
    return await Promise.race([taskPromise, timeoutPromise]);
  } catch (error) {
    if (timeoutTriggered || controller.signal.aborted || isAbortError(error)) {
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout!);
    // If the daemon ignores abort and later rejects, do not surface an unhandled rejection after
    // the CLI has already returned the timeout error to the user.
    taskPromise.catch(() => undefined);
  }
}

/** Fetch one daemon HTTP endpoint and keep the timeout active until the response is consumed. */
export function requestSessionDaemonHttp<ResultType>({
  config = resolveSessionBrokerConfig(),
  path,
  init,
  operation,
  timeoutMs,
  parse,
}: {
  config?: ResolvedSessionBrokerConfig;
  path: string;
  init?: RequestInit;
  operation: string;
  timeoutMs?: number;
  parse: (response: Response) => Promise<ResultType>;
}) {
  return withSessionDaemonHttpTimeout({
    operation,
    timeoutMs,
    task: async (signal) => parse(await fetch(`${config.httpOrigin}${path}`, { ...init, signal })),
  });
}
