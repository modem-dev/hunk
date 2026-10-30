import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateHunkSessionBrokerCredentials } from "./credentials";

const roots: string[] = [];

function isolatedEnv() {
  const root = mkdtempSync(join(tmpdir(), "hunk-credentials-test-"));
  roots.push(root);
  return { ...process.env, XDG_RUNTIME_DIR: root };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Hunk session broker credential store", () => {
  test("creates stable independent Ed25519 material with owner-private Unix permissions", async () => {
    const env = isolatedEnv();
    const first = await loadOrCreateHunkSessionBrokerCredentials({ env });
    const second = await loadOrCreateHunkSessionBrokerCredentials({ env });

    expect(second.daemonIdentity.keyId).toBe(first.daemonIdentity.keyId);
    expect(second.producer.grant.keyId).toBe(first.producer.grant.keyId);
    expect(second.caller.grant.keyId).toBe(first.caller.grant.keyId);
    expect(first.producer.grant.keyId).not.toBe(first.caller.grant.keyId);

    const securityDir = join(env.XDG_RUNTIME_DIR!, "hunk-mcp", "security-v1");
    if (process.platform !== "win32") {
      expect(lstatSync(securityDir).mode & 0o777).toBe(0o700);
      for (const name of ["daemon.json", "producer.json", "caller.json"]) {
        expect(lstatSync(join(securityDir, name)).mode & 0o777).toBe(0o600);
      }
    }
    const callerFile = readFileSync(join(securityDir, "caller.json"), "utf8");
    expect(callerFile).not.toContain("hunk-review-capability");
  });

  test("adopts one complete winner under concurrent first use", async () => {
    const env = isolatedEnv();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => loadOrCreateHunkSessionBrokerCredentials({ env })),
    );
    expect(new Set(results.map((value) => value.daemonIdentity.keyId)).size).toBe(1);
    expect(new Set(results.map((value) => value.producer.grant.keyId)).size).toBe(1);
    expect(new Set(results.map((value) => value.caller.grant.keyId)).size).toBe(1);
  });

  test("rejects malformed and overly permissive credential files without leaking private bytes", async () => {
    const env = isolatedEnv();
    await loadOrCreateHunkSessionBrokerCredentials({ env });
    const callerPath = join(env.XDG_RUNTIME_DIR!, "hunk-mcp", "security-v1", "caller.json");
    const secret = "private-secret-sentinel";
    writeFileSync(callerPath, `{"privateKey":"${secret}"}`);
    if (process.platform !== "win32") chmodSync(callerPath, 0o644);

    let message = "";
    try {
      await loadOrCreateHunkSessionBrokerCredentials({ env });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("unsafe or malformed");
    expect(message).not.toContain(secret);
  });

  test("rejects a symlinked security directory", async () => {
    if (process.platform === "win32") return;
    const env = isolatedEnv();
    const runtimeDir = join(env.XDG_RUNTIME_DIR!, "hunk-mcp");
    const target = join(env.XDG_RUNTIME_DIR!, "redirect");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(runtimeDir, { mode: 0o700 });
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(runtimeDir, "security-v1"), "dir");

    await expect(loadOrCreateHunkSessionBrokerCredentials({ env })).rejects.toThrow(
      "unsafe or malformed",
    );
  });
});
