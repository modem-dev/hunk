import { describe, expect, test } from "bun:test";
import { runAbortableCommand } from "./async-process";

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

  test("bounds combined output and reaps an overflowing child", async () => {
    await expect(
      runAbortableCommand(
        [
          process.execPath,
          "-e",
          'process.stdout.write("x".repeat(4096)); setInterval(()=>{},1000)',
        ],
        { cwd: process.cwd(), maxOutputBytes: 1024, terminationGraceMs: 25 },
      ),
    ).rejects.toThrow("output bytes");
  });

  test("times out and escalates a child that ignores termination", async () => {
    const start = Date.now();
    await expect(
      runAbortableCommand(
        [process.execPath, "-e", 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],
        { cwd: process.cwd(), timeoutMs: 100, terminationGraceMs: 25 },
      ),
    ).rejects.toThrow("timeout");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("refuses invalid UTF-8 machine output without rejecting a literal replacement character", async () => {
    await expect(
      runAbortableCommand([process.execPath, "-e", "process.stdout.write(Buffer.from([255]))"], {
        cwd: process.cwd(),
        strictUtf8: true,
      }),
    ).rejects.toThrow();
    expect(
      (
        await runAbortableCommand([process.execPath, "-e", 'process.stdout.write("\\ufffd")'], {
          cwd: process.cwd(),
          strictUtf8: true,
        })
      ).stdout,
    ).toBe("\ufffd");
  });

  test("collects output and exit status on normal completion", async () => {
    const result = await runAbortableCommand(
      [process.execPath, "-e", 'process.stdout.write("ok"); process.stderr.write("note")'],
      { cwd: process.cwd() },
    );
    expect(result).toEqual({ stdout: "ok", stderr: "note", exitCode: 0 });
  });
});
