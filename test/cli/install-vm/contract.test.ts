import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertDistinctInstallVmRuntimePaths,
  assertSafeCleanTarget,
  assertSafeInstallVmRuntimePath,
  buildDockerRunCommand,
  buildInstallVmJunit,
  evaluateCommandExpectation,
  parseInstallVmArgs,
  selectScenarios,
  validateInstallVmPins,
  validateScenarioManifest,
  type InstallVmRunResult,
} from "./contract";
import { collectInstallVmPreflightFailures } from "./preflight";
import { InstallVmCommandError, InstallVmCommandRunner } from "./runner";
import { acquireInstallVmRuntimeLock } from "./runtime-lock";

const manifest = validateScenarioManifest({
  schemaVersion: 1,
  scenarios: [
    {
      id: "negative-case",
      description: "Expected negative case",
      profile: "node",
      script: "negative-case.sh",
      network: "local",
    },
  ],
});

describe("install VM contract", () => {
  test("parses explicit selection and optional runner flags", () => {
    expect(
      parseInstallVmArgs([
        "--scenario",
        "negative-case",
        "--allow-skip",
        "--reuse-fixtures",
        "--cache-dir",
        "tmp/install-vm/cache",
      ]),
    ).toEqual({
      allowSkip: true,
      clean: false,
      list: false,
      reuseFixtures: true,
      scenarios: ["negative-case"],
      cacheDir: "tmp/install-vm/cache",
    });
    expect(() => parseInstallVmArgs(["--scenario"])).toThrow("requires a value");
    expect(() =>
      parseInstallVmArgs(["--scenario", "negative-case", "--scenario", "negative-case"]),
    ).toThrow("only once");
    expect(() => parseInstallVmArgs(["--unknown"])).toThrow("Unknown install VM option");
  });

  test("requires immutable controller and remote asset pins", () => {
    const validPins = {
      schemaVersion: 1 as const,
      controllerImage: `ubuntu@sha256:${"a".repeat(64)}`,
      verdaccioVersion: "6.10.1",
      pnpmVersion: "11.23.0",
      historical: { hunkdiffVersion: "0.19.0", bunVersion: "1.4.0" },
      firecracker: {
        version: "1.0.0",
        url: "https://example.test/firecracker",
        sha256: "a".repeat(64),
      },
      kernel: { version: "1.0.0", url: "https://example.test/kernel", sha256: "b".repeat(64) },
      rootfs: { version: "1.0.0", url: "https://example.test/rootfs", sha256: "c".repeat(64) },
      node: { version: "1.0.0", url: "https://example.test/node", sha256: "d".repeat(64) },
    };
    expect(validateInstallVmPins(validPins)).toBe(validPins);
    expect(() => validateInstallVmPins({ ...validPins, controllerImage: "ubuntu:latest" })).toThrow(
      "immutable sha256",
    );
    expect(() =>
      validateInstallVmPins({
        ...validPins,
        kernel: { url: "https://example.test/kernel", sha256: "moving" },
      }),
    ).toThrow("kernel pin needs");
    expect(() => validateInstallVmPins({ ...validPins, pnpmVersion: "latest" })).toThrow(
      "pnpm must be pinned",
    );
    expect(() =>
      validateInstallVmPins({
        ...validPins,
        historical: { ...validPins.historical, bunVersion: "^1.4.0" },
      }),
    ).toThrow("Historical bun must be pinned");
  });

  test("validates scenarios and rejects unsafe or duplicate definitions", () => {
    expect(selectScenarios(manifest, ["negative-case"])[0]?.script).toBe("negative-case.sh");
    expect(() => selectScenarios(manifest, ["missing"])).toThrow("Unknown install VM scenario");
    expect(() =>
      validateScenarioManifest({
        schemaVersion: 1,
        scenarios: [manifest.scenarios[0], manifest.scenarios[0]],
      }),
    ).toThrow("Duplicate scenario id");
    expect(() =>
      validateScenarioManifest({
        schemaVersion: 1,
        scenarios: [{ ...manifest.scenarios[0], script: "../escape.sh" }],
      }),
    ).toThrow("unsafe script path");
  });

  test("treats expected nonzero commands as passes only when diagnostics match", () => {
    expect(evaluateCommandExpectation(1, [1], "missing platform", ["missing platform"])).toEqual({
      passed: true,
      failures: [],
    });
    expect(evaluateCommandExpectation(0, [1], "").passed).toBe(false);
    expect(evaluateCommandExpectation(1, [1], "wrong output", ["required"]).passed).toBe(false);
    expect(() => evaluateCommandExpectation(1, [], "")).toThrow("cannot be empty");
  });

  test("builds a Docker invocation without privileged or repository mounts", () => {
    const command = buildDockerRunCommand(
      "hunk-install-vm:test",
      { cacheDir: "/cache", fixtureDir: "/fixtures", outputDir: "/results" },
      ["negative-case"],
      { uid: 1000, gid: 1000 },
    );
    expect(command).toContain("--cap-drop=ALL");
    expect(command).toContain("--cap-add=NET_ADMIN");
    expect(command).toContain("--cap-add=CHOWN");
    expect(command).toContain("--cap-add=DAC_OVERRIDE");
    expect(command).toContain("--security-opt=no-new-privileges");
    expect(command).toContain("--read-only");
    expect(command).not.toContain("--privileged");
    expect(command.join(" ")).not.toContain("/repo");
    expect(command.join(" ")).not.toContain("docker.sock");
  });

  test("escapes JUnit and keeps stable scenario counts", () => {
    const result: InstallVmRunResult = {
      schemaVersion: 1,
      run: {
        id: "run",
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:00:01Z",
        platform: "linux-x64",
        status: "failed",
      },
      tools: {},
      scenarios: [
        {
          id: "negative-case",
          description: "negative",
          status: "failed",
          durationMs: 1250,
          exitCode: 1,
          commands: [
            {
              id: "command",
              status: "failed",
              expectation: "exit 0",
              exitCode: 1,
              logPath: "commands/command.log",
            },
          ],
          observations: {},
          assertions: [
            {
              id: "message",
              status: "failed",
              expected: "safe",
              actual: "unsafe",
              message: 'x < y & "quoted"',
            },
          ],
          artifacts: [],
        },
      ],
    };
    const junit = buildInstallVmJunit(result);
    expect(junit).toContain('tests="1" failures="1" skipped="0"');
    expect(junit).toContain("x &lt; y &amp; &quot;quoted&quot;");
    expect(junit).not.toContain('x < y & "quoted"');
  });

  test("allows cleaning only real harness-owned paths and rejects symlink ancestors", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "hunk-install-vm-contract-"));
    const outside = mkdtempSync(path.join(tmpdir(), "hunk-install-vm-outside-"));
    try {
      const runtime = path.join(repo, "tmp", "install-vm");
      mkdirSync(runtime, { recursive: true });
      expect(assertSafeCleanTarget(repo, path.join(runtime, "cache"))).toBe(
        path.join(runtime, "cache"),
      );
      expect(() => assertSafeCleanTarget(repo, repo)).toThrow("outside");
      expect(() => assertSafeInstallVmRuntimePath(repo, path.join(runtime, "bad,path"))).toThrow(
        "commas",
      );
      symlinkSync(outside, path.join(runtime, "linked"));
      symlinkSync(path.join(outside, "missing"), path.join(runtime, "dangling"));
      writeFileSync(path.join(outside, "preserve"), "still here\n");
      expect(() => assertSafeCleanTarget(repo, path.join(runtime, "linked"))).toThrow(
        "symlink ancestor",
      );
      expect(() => assertSafeCleanTarget(repo, path.join(runtime, "dangling", "child"))).toThrow(
        "symlink ancestor",
      );
      expect(Bun.file(path.join(outside, "preserve")).size).toBeGreaterThan(0);
      expect(() =>
        assertDistinctInstallVmRuntimePaths({
          cache: path.join(runtime, "cache"),
          output: path.join(runtime, "cache", "results"),
        }),
      ).toThrow("overlap");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("acquires one runtime lock and reclaims a stale pid without deleting a racing owner", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hunk-install-vm-lock-"));
    const lock = path.join(root, ".lock");
    try {
      const release = acquireInstallVmRuntimeLock(lock, { pid: 101, alive: () => true });
      expect(() => acquireInstallVmRuntimeLock(lock, { pid: 202, alive: () => true })).toThrow(
        "already running",
      );
      release();
      mkdirSync(lock);
      writeFileSync(path.join(lock, "owner.json"), '{"pid":303}\n');
      const releaseReclaimed = acquireInstallVmRuntimeLock(lock, {
        pid: 404,
        alive: () => false,
      });
      releaseReclaimed();

      mkdirSync(lock);
      writeFileSync(path.join(lock, "owner.json"), '{"pid":505}\n');
      let raced = false;
      expect(() =>
        acquireInstallVmRuntimeLock(lock, {
          pid: 606,
          alive: (pid) => pid === 707,
          beforeStaleClaim: () => {
            if (raced) return;
            raced = true;
            rmSync(lock, { recursive: true });
            mkdirSync(lock);
            writeFileSync(path.join(lock, "owner.json"), '{"pid":707}\n');
          },
        }),
      ).toThrow("already running under pid 707");
      expect(readFileSync(path.join(lock, "owner.json"), "utf8")).toContain("707");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("terminates an asynchronously spawned host command at its deadline", async () => {
    const runner = new InstallVmCommandRunner();
    runner.start();
    try {
      const failure = await runner
        .run([process.execPath, "-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 10 })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(InstallVmCommandError);
      expect((failure as InstallVmCommandError).exitCode).toBe(124);
    } finally {
      runner.stop();
    }
  });

  test("replaces a pending timeout kill when an interrupt overlaps it", async () => {
    const runner = new InstallVmCommandRunner();
    runner.start();
    try {
      const command = runner.run(
        [process.execPath, "-e", 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60_000)'],
        { timeoutMs: 10 },
      );
      await Bun.sleep(20);
      process.emit("SIGINT", "SIGINT");
      const startedAt = Date.now();
      const failure = await command.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(InstallVmCommandError);
      expect((failure as InstallVmCommandError).exitCode).toBe(130);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      runner.stop();
    }
  });

  test("reports optional preflight failures through injected probes", async () => {
    expect(
      await collectInstallVmPreflightFailures("/tmp", {
        platform: "darwin",
        arch: "arm64",
        dockerProbe: () => 1,
        accessProbe: () => {
          throw new Error("missing");
        },
        availableBytes: 0,
      }),
    ).toHaveLength(5);
    expect(
      await collectInstallVmPreflightFailures("/tmp", {
        platform: "linux",
        arch: "x64",
        dockerProbe: () => 0,
        accessProbe: () => {},
        availableBytes: 10 * 1024 ** 3,
      }),
    ).toEqual([]);
  });
});
