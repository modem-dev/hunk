/** Default byte ceiling for exact source text loaded for expanded context. */
export const DEFAULT_SOURCE_TEXT_MAX_BYTES = 1_000_000;

/** Structural result shared by bounded filesystem source readers. */
export type LimitedSourceTextResult = string | null | { kind: "too-large"; maxBytes: number };

/** Keep source-load diagnostics terse enough to be useful in logs. */
export function logSourceDiagnostic(message: string, detail?: unknown) {
  if (detail instanceof Error) {
    console.error(`hunk: ${message}: ${detail.message}`, detail);
    return;
  }

  const firstLine =
    typeof detail === "string"
      ? detail
          .split("\n")
          .map((line) => line.trim())
          .find(Boolean)
      : undefined;
  console.error(firstLine ? `hunk: ${message}: ${firstLine}` : `hunk: ${message}`);
}

/** Read one filesystem source as text without exceeding the supplied byte ceiling. */
export async function readFileTextWithLimit(
  absolutePath: string,
  maxBytes: number,
): Promise<LimitedSourceTextResult> {
  try {
    const file = Bun.file(absolutePath);
    if (!(await file.exists())) {
      return null;
    }
    if (file.size > maxBytes) {
      return { kind: "too-large", maxBytes };
    }
    return await file.text();
  } catch (error) {
    logSourceDiagnostic(`failed to read source file ${absolutePath}`, error);
    return null;
  }
}

const SOURCE_SUBPROCESS_GRACE_MS = 100;
const SOURCE_SUBPROCESS_FORCE_WAIT_MS = 250;

/** Wait a bounded interval for a source-reader subprocess to exit. */
function waitForSourceSubprocessExit(proc: Bun.ReadableSubprocess, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    void proc.exited.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

/** Terminate a source-reader subprocess without letting cleanup block indefinitely. */
export async function terminateSourceSubprocess(proc: Bun.ReadableSubprocess) {
  try {
    proc.kill("SIGTERM");
  } catch {
    // The process may have exited between the stream failure and cleanup.
  }
  if (await waitForSourceSubprocessExit(proc, SOURCE_SUBPROCESS_GRACE_MS)) {
    return;
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // A concurrent exit needs no further signal.
  }
  await waitForSourceSubprocessExit(proc, SOURCE_SUBPROCESS_FORCE_WAIT_MS);
}

/** Read a byte stream as text while enforcing a caller-defined resource limit. */
export async function readStreamTextWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onTooLarge?: () => void,
  createLimitError: (maxBytes: number) => Error = (limit) =>
    new Error(`Source text exceeds ${limit} bytes.`),
) {
  if (!stream) {
    return "";
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      onTooLarge?.();
      await reader.cancel().catch(() => undefined);
      throw createLimitError(maxBytes);
    }

    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(combined);
}
