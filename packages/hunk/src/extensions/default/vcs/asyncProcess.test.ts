import { describe, expect, test } from "bun:test";
import { runAbortableCommand } from "./asyncProcess";

describe("abortable bundled VCS subprocesses", () => {
  test("does not spawn after cancellation already won", async () => {
    const abort = new AbortController();
    abort.abort(new Error("cancelled before spawn"));
    await expect(
      runAbortableCommand([process.execPath, "-e", "process.exit(99)"], {
        cwd: process.cwd(),
        signal: abort.signal,
      }),
    ).rejects.toThrow("cancelled before spawn");
  });

  test("terminates, escalates, and reaps a command that ignores graceful cancellation", async () => {
    const abort = new AbortController();
    const startedAt = Date.now();
    const pending = runAbortableCommand(
      [
        process.execPath,
        "-e",
        'process.on("SIGTERM",()=>{}); process.stdout.write("started\\n"); setTimeout(()=>process.stdout.write("late\\n"),5000)',
      ],
      { cwd: process.cwd(), signal: abort.signal, terminationGraceMs: 25 },
    );
    setTimeout(() => abort.abort(new Error("provider cancelled")), 20);
    await expect(pending).rejects.toThrow("provider cancelled");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("collects output and exit status on normal completion", async () => {
    const result = await runAbortableCommand(
      [process.execPath, "-e", 'process.stdout.write("ok"); process.stderr.write("note")'],
      { cwd: process.cwd() },
    );
    expect(result).toEqual({ stdout: "ok", stderr: "note", exitCode: 0 });
  });
});
