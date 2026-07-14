import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { renderWatchMarkdown } from "./report";
import { campaignConfigSchema, parseWatchRunRecord, verifyBinaryProvenance } from "./schema";
import { createTestWatchRunRecord } from "./test-helpers";

let tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

describe("watch campaign configuration schema", () => {
  test("accepts canonical UTC campaign IDs", () => {
    expect(
      campaignConfigSchema.shape.campaignId.parse("watch-20260714T172412Z-bb653b705-he36fce99"),
    ).toBe("watch-20260714T172412Z-bb653b705-he36fce99");
  });
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
    expect(markdown).toContain("Execution mode: **final**");
    expect(markdown).toContain("Startup mean");
    expect(markdown).toContain("projected");
    expect(markdown).toContain("Valid records: 1/1");

    const preflight = renderWatchMarkdown([{ ...record, executionMode: "preflight" }]);
    expect(preflight).toContain("PRELIMINARY PREFLIGHT ONLY");
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
    const provenance = {
      schemaVersion: 1,
      revision: "candidate",
      sourceSha,
      executablePath,
      sha256,
      sizeBytes: 16,
      platform: platform(),
      arch: arch(),
      fileArchitecture: "test native executable",
      processArchitecture: arch(),
      host: { hostname: "test", platform: platform(), release: "test", arch: arch() },
      bun: { path: join(root, "bun"), version: "1.3.14", arch: arch() },
      build: {
        installCommand: [join(root, "bun"), "install", "--frozen-lockfile"],
        command: [join(root, "bun"), "run", "./scripts/build-bin.ts"],
        environment: { PATH: root, SKIP_INSTALL_SIMPLE_GIT_HOOKS: "1" },
        startedAt: "2026-07-14T00:00:00.000Z",
        finishedAt: "2026-07-14T00:00:01.000Z",
        durationMs: 1_000,
        order: 1,
        stdoutLogPath: join(root, "stdout.log"),
        stderrLogPath: join(root, "stderr.log"),
      },
      checksumTool:
        process.platform === "darwin"
          ? "shasum -a 256"
          : process.platform === "linux"
            ? "sha256sum"
            : "Get-FileHash SHA256",
      smoke: {
        command: [executablePath, "--help"],
        exitCode: 0,
        stdoutSha256: sha256,
        stderrSha256: sha256,
        succeeded: true,
      },
    };
    writeFileSync(provenancePath, JSON.stringify(provenance));

    expect(
      verifyBinaryProvenance("candidate", executablePath, provenancePath, sourceSha).sha256,
    ).toBe(sha256);
    expect(() =>
      verifyBinaryProvenance("candidate", executablePath, provenancePath, "c".repeat(40)),
    ).toThrow("source SHA");
    writeFileSync(
      provenancePath,
      JSON.stringify({ ...provenance, arch: arch() === "arm64" ? "x64" : "arm64" }),
    );
    expect(() =>
      verifyBinaryProvenance("candidate", executablePath, provenancePath, sourceSha),
    ).toThrow("architecture");
    writeFileSync(provenancePath, JSON.stringify(provenance));
    writeFileSync(executablePath, "changed\n");
    expect(() =>
      verifyBinaryProvenance("candidate", executablePath, provenancePath, sourceSha),
    ).toThrow("SHA256 mismatch");
    expect(() =>
      verifyBinaryProvenance("candidate", "relative-hunk", provenancePath, sourceSha),
    ).toThrow("absolute");
    const alternateExecutablePath = join(
      root,
      process.platform === "win32" ? "other.exe" : "other",
    );
    writeFileSync(alternateExecutablePath, "changed\n");
    expect(() =>
      verifyBinaryProvenance("candidate", alternateExecutablePath, provenancePath, sourceSha),
    ).toThrow("provenance executable path mismatch");
  });
});
