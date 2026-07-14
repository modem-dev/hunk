import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { renderWatchMarkdown } from "./report";
import { parseWatchRunRecord, verifyBinaryProvenance } from "./schema";
import { createTestWatchRunRecord } from "./test-helpers";

let tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

describe("watch campaign raw schema", () => {
  test("accepts measured records and rejects projected or run-kind mismatches", () => {
    const record = createTestWatchRunRecord();
    expect(parseWatchRunRecord(record)).toEqual(record);
    expect(() => parseWatchRunRecord({ ...record, measurement: "projected" })).toThrow();
    expect(() => parseWatchRunRecord({ ...record, runKind: "idle" })).toThrow();

    const failed = {
      ...record,
      startup: null,
      valid: false,
      cleanupComplete: false,
      errors: [{ code: "FAILED", phase: "startup", message: "preserved" }],
    };
    expect(parseWatchRunRecord(failed).valid).toBe(false);
  });

  test("renders per-host Markdown and labels projections explicitly", () => {
    const record = createTestWatchRunRecord();
    const markdown = renderWatchMarkdown([record]);
    expect(markdown).toContain("# Watch benchmark — test-host");
    expect(markdown).toContain("Startup mean");
    expect(markdown).toContain("projected");
    expect(markdown).toContain("Valid records: 1/1");
  });
});

describe("watch campaign binary provenance", () => {
  test("rejects checksum, expected source SHA, architecture, and relative paths", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-watch-provenance-test-"));
    tempRoots.push(root);
    const executablePath = join(root, process.platform === "win32" ? "hunk.exe" : "hunk");
    const provenancePath = join(root, "provenance.json");
    writeFileSync(executablePath, "test executable\n");
    chmodSync(executablePath, 0o755);
    const sourceSha = "b".repeat(40);
    const sha256 = createHash("sha256").update("test executable\n").digest("hex");
    writeFileSync(
      provenancePath,
      JSON.stringify({ schemaVersion: 1, sha256, sourceSha, platform: platform(), arch: arch() }),
    );

    expect(
      verifyBinaryProvenance("candidate", executablePath, provenancePath, sourceSha).sha256,
    ).toBe(sha256);
    expect(() =>
      verifyBinaryProvenance("candidate", executablePath, provenancePath, "c".repeat(40)),
    ).toThrow("source SHA");
    writeFileSync(
      provenancePath,
      JSON.stringify({
        schemaVersion: 1,
        sha256,
        sourceSha,
        platform: platform(),
        arch: arch() === "arm64" ? "x64" : "arm64",
      }),
    );
    expect(() =>
      verifyBinaryProvenance("candidate", executablePath, provenancePath, sourceSha),
    ).toThrow("architecture");
    writeFileSync(
      provenancePath,
      JSON.stringify({ schemaVersion: 1, sha256, sourceSha, platform: platform(), arch: arch() }),
    );
    writeFileSync(executablePath, "changed\n");
    expect(() =>
      verifyBinaryProvenance("candidate", executablePath, provenancePath, sourceSha),
    ).toThrow("SHA256 mismatch");
    expect(() =>
      verifyBinaryProvenance("candidate", "relative-hunk", provenancePath, sourceSha),
    ).toThrow("absolute");
  });
});
