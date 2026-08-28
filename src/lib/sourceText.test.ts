import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTextWithLimit, terminateSourceSubprocess } from "./sourceText";

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
