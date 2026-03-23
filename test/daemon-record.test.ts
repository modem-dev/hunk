import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearDaemonRecord,
  readDaemonRecord,
  resolveDaemonRecordPath,
  writeDaemonRecord,
} from "../src/mcp/daemonRecord";
import type { ResolvedHunkMcpConfig } from "../src/mcp/config";

const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;

const config: ResolvedHunkMcpConfig = {
  host: "127.0.0.1",
  port: 47657,
  httpOrigin: "http://127.0.0.1:47657",
  wsOrigin: "ws://127.0.0.1:47657",
};

afterEach(() => {
  if (originalRuntimeDir === undefined) {
    delete process.env.XDG_RUNTIME_DIR;
  } else {
    process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
  }
});

describe("daemon record", () => {
  test("writes, reads, and clears one trusted daemon record", () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "hunk-daemon-record-"));
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const record = {
      pid: 4242,
      startedAt: "2026-03-23T00:00:00.000Z",
      instanceId: "instance-1",
    };

    try {
      expect(readDaemonRecord(config)).toBeNull();

      writeDaemonRecord(record, config);
      expect(readDaemonRecord(config)).toEqual(record);

      clearDaemonRecord({ pid: 9999, instanceId: "other-instance" }, config);
      expect(readDaemonRecord(config)).toEqual(record);

      clearDaemonRecord({ pid: record.pid, instanceId: record.instanceId }, config);
      expect(readDaemonRecord(config)).toBeNull();
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  test("separates daemon records by host and port", () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "hunk-daemon-record-paths-"));
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    try {
      const first = resolveDaemonRecordPath(config);
      const second = resolveDaemonRecordPath({
        ...config,
        host: "localhost",
        port: 47658,
        httpOrigin: "http://localhost:47658",
        wsOrigin: "ws://localhost:47658",
      });

      expect(first).not.toBe(second);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});
