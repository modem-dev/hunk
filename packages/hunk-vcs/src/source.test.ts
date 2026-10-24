import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readFileBytesWithLimit,
  readFileTextWithLimit,
  readStreamBytesWithLimit,
  terminateSourceSubprocess,
} from "./source";

const tempDirs: string[] = [];

/** Create one temporary source directory tracked for cleanup. */
function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-source-text-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("readFileTextWithLimit", () => {
  test("returns text, missing, and structural too-large results", async () => {
    const dir = createTempDir();
    const source = join(dir, "source.txt");
    writeFileSync(source, "source text\n");

    expect(await readFileTextWithLimit(source, 100)).toBe("source text\n");
    expect(await readFileTextWithLimit(join(dir, "missing.txt"), 100)).toBeNull();
    expect(await readFileTextWithLimit(source, 5)).toEqual({ kind: "too-large", maxBytes: 5 });
  });
});

describe("readFileBytesWithLimit", () => {
  test("returns exact bytes, missing, and structural too-large results", async () => {
    const dir = createTempDir();
    const source = join(dir, "image.bin");
    // Bytes that are not valid UTF-8 must come back unchanged rather than decoded.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    writeFileSync(source, bytes);

    expect(await readFileBytesWithLimit(source, 100)).toEqual(bytes);
    expect(await readFileBytesWithLimit(join(dir, "missing.bin"), 100)).toBeNull();
    expect(await readFileBytesWithLimit(source, 3)).toEqual({ kind: "too-large", maxBytes: 3 });
  });
});

describe("readStreamBytesWithLimit", () => {
  test("joins chunks without decoding and stops past the limit", async () => {
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0xff, 0x00]));
          controller.enqueue(new Uint8Array([0xfe]));
          controller.close();
        },
      });
    let stopped = false;

    expect(await readStreamBytesWithLimit(stream(), 3)).toEqual(new Uint8Array([0xff, 0x00, 0xfe]));
    expect(await readStreamBytesWithLimit(null, 3)).toEqual(new Uint8Array());
    await expect(
      readStreamBytesWithLimit(stream(), 2, () => {
        stopped = true;
      }),
    ).rejects.toThrow("Source bytes exceed 2 bytes.");
    expect(stopped).toBe(true);
  });
});

describe("terminateSourceSubprocess", () => {
  test("forces termination and stops waiting when a subprocess never reports exit", async () => {
    const signals: Array<string | number | undefined> = [];
    const neverExits = new Promise<number>(() => undefined);
    const proc = {
      exited: neverExits,
      kill(signal?: string | number) {
        signals.push(signal);
      },
    } as unknown as Bun.ReadableSubprocess;
    const startedAt = performance.now();

    await terminateSourceSubprocess(proc);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
