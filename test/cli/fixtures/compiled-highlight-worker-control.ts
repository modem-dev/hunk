import {
  createHighlightWorker,
  supportsHighlightWorkerOffload,
} from "../../../packages/hunk/src/highlightWorkerClient";

if (!supportsHighlightWorkerOffload()) {
  process.stdout.write("compiled highlight worker disabled\n");
} else {
  const worker = createHighlightWorker();
  const timeout = setTimeout(() => {
    process.stderr.write("Timed out waiting for the compiled highlight worker.\n");
    void worker.terminate();
    process.exit(1);
  }, 5_000);

  worker.onerror = (event) => {
    clearTimeout(timeout);
    process.stderr.write(`${event.message || "The compiled highlight worker failed."}\n`);
    void worker.terminate();
    process.exit(1);
  };

  worker.onmessage = (event: MessageEvent) => {
    clearTimeout(timeout);
    const response = event.data as { version?: unknown; id?: unknown; ok?: unknown };
    if (response.version !== 3 || response.id !== 1 || response.ok !== false) {
      process.stderr.write(
        `Unexpected compiled highlight worker response: ${JSON.stringify(response)}\n`,
      );
      void worker.terminate();
      process.exit(1);
    }

    process.stdout.write("compiled highlight worker ready\n");
    void worker.terminate();
  };

  // The unsupported version asks the real worker protocol for its cheapest deterministic response.
  worker.postMessage({ version: 0, id: 1 });
}
