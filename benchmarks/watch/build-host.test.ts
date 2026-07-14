import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  compiledBinaryName,
  exactBuildCommands,
  hostBuildOrder,
  parsePeArchitecture,
  prepareRevisionBuildAttempt,
  windowsChecksumCommand,
} from "./build-host";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** Create one minimal PE header with a selected COFF machine type. */
function peBytes(machine: number): Uint8Array {
  const bytes = new Uint8Array(128);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x5a4d, true);
  view.setUint32(0x3c, 64, true);
  view.setUint32(64, 0x00004550, true);
  view.setUint16(68, machine, true);
  return bytes;
}

describe("watch host build policy", () => {
  test("selects native binary names and deterministic alternating order", () => {
    expect(compiledBinaryName("darwin")).toBe("hunk");
    expect(compiledBinaryName("linux")).toBe("hunk");
    expect(compiledBinaryName("win32")).toBe("hunk.exe");
    expect(hostBuildOrder("campaign", "host")).toEqual(hostBuildOrder("campaign", "host"));
    expect(new Set(hostBuildOrder("campaign", "host"))).toEqual(new Set(["base", "candidate"]));
  });

  test("uses the exact pinned Bun path with no PATH executable fallback", () => {
    const bunPath =
      process.platform === "win32" ? "C:\\Pinned Bun\\bun.exe" : "/opt/pinned bun/bin/bun";
    expect(exactBuildCommands(bunPath)).toEqual({
      installCommand: [bunPath, "install", "--frozen-lockfile"],
      buildCommand: [bunPath, "run", "./scripts/build-bin.ts"],
    });
    expect(exactBuildCommands(bunPath).buildCommand[0]).not.toBe("bun");
  });

  test("recovers only an owned incomplete attempt and writes a fresh marker", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-build-retry-test-"));
    roots.push(root);
    const markerPath = join(root, "state", "base.json");
    const checkout = join(root, "build", "base");
    const log = join(root, "base.log");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "partial"), "partial\n");
    writeFileSync(log, "partial log\n");
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        campaignId: "campaign",
        hostId: "linux-x64-sentry-agent",
        revision: "base",
      })}\n`,
    );
    prepareRevisionBuildAttempt({
      markerPath,
      campaignId: "campaign",
      hostId: "linux-x64-sentry-agent",
      revision: "base",
      ownedPaths: [checkout, log],
    });
    expect(existsSync(checkout)).toBe(false);
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(markerPath, "utf8")).toContain('"revision":"base"');

    writeFileSync(markerPath, '{"campaignId":"other"}\n');
    expect(() =>
      prepareRevisionBuildAttempt({
        markerPath,
        campaignId: "campaign",
        hostId: "linux-x64-sentry-agent",
        revision: "base",
        ownedPaths: [checkout],
      }),
    ).toThrow("ownership mismatch");

    rmSync(markerPath);
    mkdirSync(checkout, { recursive: true });
    expect(() =>
      prepareRevisionBuildAttempt({
        markerPath,
        campaignId: "campaign",
        hostId: "linux-x64-sentry-agent",
        revision: "base",
        ownedPaths: [checkout],
      }),
    ).toThrow("unowned incomplete");
  });

  test("probes PE architecture and keeps spaced Windows paths as separate arguments", () => {
    expect(parsePeArchitecture(peBytes(0xaa64))).toBe("arm64");
    expect(parsePeArchitecture(peBytes(0x8664))).toBe("x64");
    expect(() => parsePeArchitecture(peBytes(0x014c))).toThrow("Unsupported PE machine");
    const path = "C:\\DEV\\Watch Campaign\\candidate hunk.exe";
    const expectedSha256 = "a".repeat(64);
    const command = windowsChecksumCommand(path, expectedSha256);
    expect(command.at(-2)).toBe(path);
    expect(command.at(-1)).toBe(expectedSha256);
    expect(command.at(-3)).not.toContain(path);
    expect(command.at(-3)).toContain("Get-FileHash");
  });
});
