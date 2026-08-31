import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertDistinctInstallVmRuntimePaths,
  assertSafeCleanTarget,
  assertSafeInstallVmRuntimePath,
  buildControllerImageCommand,
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

    const buildCommand = buildControllerImageCommand("hunk-install-vm:test", "/harness", validPins);
    expect(buildCommand).toContain(`CONTROLLER_IMAGE=${validPins.controllerImage}`);
    expect(buildCommand).toContain(`NODE_VERSION=${validPins.node.version}`);
    expect(buildCommand).toContain(`NODE_URL=${validPins.node.url}`);
    expect(buildCommand).toContain(`NODE_SHA256=${validPins.node.sha256}`);
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
    expect(
      validateScenarioManifest({
        schemaVersion: 1,
        scenarios: [
          {
            ...manifest.scenarios[0],
            requiredEvidence: {
              commands: ["run-upgrade"],
              commandExpectations: { "run-upgrade": "exit 0" },
              assertions: ["daemon-preserved"],
              observations: ["oldDaemonPid", "transcriptPath"],
            },
          },
        ],
      }).scenarios[0]?.requiredEvidence,
    ).toEqual({
      commands: ["run-upgrade"],
      commandExpectations: { "run-upgrade": "exit 0" },
      assertions: ["daemon-preserved"],
      observations: ["oldDaemonPid", "transcriptPath"],
    });
    for (const requiredEvidence of [
      { commands: ["duplicate", "duplicate"] },
      { commands: ["run-upgrade"], commandExpectations: {} },
      { commands: ["run-upgrade"], commandExpectations: { other: "exit 0" } },
      {
        commands: ["run-upgrade"],
        commandExpectations: { "run-upgrade": "anything passed" },
      },
      { assertions: ["Uppercase"] },
      { observations: ["not-kebab-case"] },
      { unknown: ["value"] },
    ]) {
      expect(() =>
        validateScenarioManifest({
          schemaVersion: 1,
          scenarios: [{ ...manifest.scenarios[0], requiredEvidence }],
        }),
      ).toThrow();
    }
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
        sourceIdentity: "a".repeat(64),
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

  test("acquires one runtime lock and refuses to reclaim stale or invalid owners", () => {
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
      expect(() =>
        acquireInstallVmRuntimeLock(lock, {
          pid: 404,
          alive: () => false,
        }),
      ).toThrow("belongs to stale pid 303");
      expect(readFileSync(path.join(lock, "owner.json"), "utf8")).toContain("303");

      writeFileSync(path.join(lock, "owner.json"), '{"pid":"broken"}\n');
      expect(() => acquireInstallVmRuntimeLock(lock, { pid: 505 })).toThrow("has no valid owner");
      expect(readFileSync(path.join(lock, "owner.json"), "utf8")).toContain("broken");
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

  test("replaces the timeout's pending kill when an interrupt overlaps it", async () => {
    let nextTimer = 0;
    const timers = new Map<number, { callback: () => void; delayMs: number }>();
    const cancelled: number[] = [];
    const kills: NodeJS.Signals[] = [];
    let resolveExit!: (exitCode: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const runner = new InstallVmCommandRunner({
      spawn: () => ({
        exited,
        kill: (signal) => {
          kills.push(signal);
          if (signal === "SIGINT") resolveExit(130);
        },
      }),
      schedule: (callback, delayMs) => {
        const timer = ++nextTimer;
        timers.set(timer, { callback, delayMs });
        return timer;
      },
      cancel: (timer) => {
        const id = timer as number;
        cancelled.push(id);
        timers.delete(id);
      },
    });
    runner.start();
    try {
      const command = runner.run(["fake-command"], { timeoutMs: 10 });
      const timeoutTimer = [...timers.keys()][0]!;
      expect(timers.get(timeoutTimer)?.delayMs).toBe(10);
      const timeoutCallback = timers.get(timeoutTimer)!.callback;
      timers.delete(timeoutTimer);
      timeoutCallback();

      expect(kills).toEqual(["SIGTERM"]);
      const timeoutKillTimer = [...timers.keys()][0]!;
      expect(timers.get(timeoutKillTimer)?.delayMs).toBe(10_000);

      process.emit("SIGINT", "SIGINT");
      expect(kills).toEqual(["SIGTERM", "SIGINT"]);
      expect(cancelled).toContain(timeoutKillTimer);
      const interruptKillTimer = [...timers.keys()][0]!;
      expect(interruptKillTimer).not.toBe(timeoutKillTimer);
      expect(timers.get(interruptKillTimer)?.delayMs).toBe(10_000);

      const failure = await command.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(InstallVmCommandError);
      expect((failure as InstallVmCommandError).exitCode).toBe(130);
      expect(cancelled).toContain(interruptKillTimer);
      expect(timers.size).toBe(0);
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
