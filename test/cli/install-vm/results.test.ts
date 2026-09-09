import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  aggregateInstallVmResults,
  parseAssertionTsv,
  parseCommandTsv,
  parseObservationTsv,
  validateInstallVmReleaseResult,
} from "./results";

const sourceIdentity = "a".repeat(64);

const scenario = {
  id: "negative-case",
  description: "Expected failure contract",
  profile: "node" as const,
  script: "negative-case.sh",
  network: "local" as const,
};

const daemonScenario = {
  id: "authenticated-daemon-upgrade",
  description: "Daemon upgrade evidence",
  profile: "node" as const,
  script: "authenticated-daemon-upgrade.sh",
  network: "local" as const,
  requiredEvidence: {
    commands: ["upgrade-daemon-b"],
    commandExpectations: { "upgrade-daemon-b": "exit 0" },
  },
};

/** Write a compact but semantically complete authenticated-upgrade release result. */
function writeDaemonReleaseEvidence(output: string) {
  const directory = path.join(output, "scenarios", daemonScenario.id);
  mkdirSync(directory, { recursive: true });
  const observations = {
    daemonPackageVersionA: "899.0.0",
    daemonPackageVersionB: "899.0.1",
    daemonRevisionA: "10",
    daemonRevisionB: "11",
    daemonUpgradeBuildInputIdentity: "c".repeat(64),
    oldDaemonPid: "100",
    oldDaemonStartToken: "1000",
    newDaemonPid: "200",
    newDaemonStartToken: "2000",
    oldClientPid: "101",
    oldClientStartToken: "1001",
    newFirstClientPid: "201",
    newFirstClientStartToken: "2001",
    newSecondClientPid: "202",
    newSecondClientStartToken: "2002",
    newFirstWrapperStartToken: "3001",
    newSecondWrapperStartToken: "3002",
    oldExecutableDigest: "a".repeat(64),
    newExecutableDigest: "b".repeat(64),
    oldExecutableLocation: "/fixture/a",
    newExecutableLocation: "/fixture/b",
    oldExecutablePath: "old-executable.txt",
    newExecutablePath: "new-executable.txt",
    fixtureManifestPath: "daemon-fixture-manifest.json",
    reconnectDurationMs: "70000",
    overlapHealthPath: "overlap-health.json",
    recoveredHealthPath: "recovered-health.json",
    oldMetadataPath: "old-metadata.json",
    recoveredMetadataPath: "recovered-metadata.json",
    oldSessionListPath: "old-session-list.json",
    firstRecoveredSessionListPath: "first-recovered-session-list.json",
    recoveredSessionListPath: "recovered-session-list.json",
    incompatibleWarningPath: "incompatible-warning.log",
  };
  const files: Record<string, string> = {
    "overlap-health.json": '{"ok":true}',
    "recovered-health.json": '{"ok":true}',
    "old-metadata.json": '{"pid":100}',
    "recovered-metadata.json": '{"pid":200}',
    "old-session-list.json": '{"sessions":[{"pid":101}]}',
    "first-recovered-session-list.json": '{"sessions":[{"pid":201}]}',
    "recovered-session-list.json": '{"sessions":[{"pid":201},{"pid":202}]}',
    "incompatible-warning.log":
      "Close older Hunk windows; this window will reconnect automatically.\n",
    "old-executable.txt": `pid=100\nstartToken=1000\nlocation=/fixture/a\ndigest=${"a".repeat(64)}\n`,
    "new-executable.txt": `pid=200\nstartToken=2000\nlocation=/fixture/b\ndigest=${"b".repeat(64)}\n`,
    "daemon-fixture-manifest.json": JSON.stringify({
      schemaVersion: 2,
      sourceIdentity,
      daemonUpgradeBuildInputIdentity: "c".repeat(64),
      daemonUpgrade: {
        versionA: "899.0.0",
        versionB: "899.0.1",
        revisionA: 10,
        revisionB: 11,
        binarySha256A: "a".repeat(64),
        binarySha256B: "b".repeat(64),
      },
    }),
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    writeFileSync(path.join(directory, relativePath), contents);
  }
  const artifacts = Object.keys(files).map((relativePath) =>
    path.posix.join("scenarios", daemonScenario.id, relativePath),
  );
  const result = {
    schemaVersion: 1 as const,
    run: {
      id: "run",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:02:00Z",
      platform: "linux-x64" as const,
      sourceIdentity,
      status: "passed" as const,
    },
    tools: {
      firecracker: "Firecracker v1.16.1",
      kernel: "6.18.44",
      node: "v24.14.1",
      npm: "11.11.0",
      pnpm: "11.23.0",
      verdaccio: "v6.10.1",
    },
    scenarios: [
      {
        id: daemonScenario.id,
        description: daemonScenario.description,
        status: "passed" as const,
        durationMs: 100,
        exitCode: 0,
        commands: [
          {
            id: "upgrade-daemon-b",
            status: "passed" as const,
            expectation: "exit 0",
            exitCode: 0,
            logPath: "incompatible-warning.log",
          },
        ],
        observations,
        assertions: [
          {
            id: "migration",
            status: "passed" as const,
            expected: "recovered",
            actual: "recovered",
            message: "evidence matched",
          },
        ],
        artifacts,
      },
    ],
  };
  return { result, directory };
}

describe("install VM results", () => {
  test("parses assertion protocol and rejects malformed fields", () => {
    expect(parseAssertionTsv("missing\tpassed\texit 1\texit 1\texpected failure\n")).toEqual([
      {
        id: "missing",
        status: "passed",
        expected: "exit 1",
        actual: "exit 1",
        message: "expected failure",
      },
    ]);
    expect(() => parseAssertionTsv("bad\tunknown\tx\ty\tz\n")).toThrow("Invalid assertion status");
    expect(() => parseAssertionTsv("too\tfew\tfields\n")).toThrow("Malformed assertion TSV");
  });

  test("parses structured commands and observations without embedding logs", () => {
    expect(parseCommandTsv("version\tpassed\texit 0\t0\tcommands/version.log\n")).toEqual([
      {
        id: "version",
        status: "passed",
        expectation: "exit 0",
        exitCode: 0,
        logPath: "commands/version.log",
      },
    ]);
    expect(
      parseObservationTsv("hunkVersion\t1.2.3\ndependencyTreePath\tdependency.json\n"),
    ).toEqual({
      hunkVersion: "1.2.3",
      dependencyTreePath: "dependency.json",
    });
    expect(() => parseCommandTsv("bad\tpassed\texit 0\tNaN\tcommands/bad.log\n")).toThrow(
      "exit code",
    );
    expect(() => parseObservationTsv("dependencyTreePath\t../secret\n")).toThrow("Unsafe");
    expect(() => parseObservationTsv("dependencyTreePath\t..\n")).toThrow("Unsafe");
    expect(() => parseCommandTsv("bad\tpassed\texit 0\t0\t..\n")).toThrow("Unsafe");
  });

  test("release validation rejects stale, partial, and non-passing evidence", () => {
    const releaseExpected = {
      sourceIdentity,
      pnpmVersion: "11.23.0",
      scenarios: [scenario],
    };
    const result = {
      schemaVersion: 1 as const,
      run: {
        id: "run",
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:00:01Z",
        platform: "linux-x64" as const,
        sourceIdentity,
        status: "passed" as const,
      },
      tools: {
        firecracker: "Firecracker v1.16.1",
        kernel: "6.18.44",
        node: "v24.14.1",
        npm: "11.11.0",
        pnpm: releaseExpected.pnpmVersion,
        verdaccio: "v6.10.1",
      },
      scenarios: [
        {
          id: scenario.id,
          description: scenario.description,
          status: "passed" as const,
          durationMs: 10,
          exitCode: 0,
          commands: [
            {
              id: "command",
              status: "passed" as const,
              expectation: "exit 0",
              exitCode: 0,
              logPath: "commands/command.log",
            },
          ],
          observations: {},
          assertions: [
            {
              id: "assertion",
              status: "passed" as const,
              expected: "safe",
              actual: "safe",
              message: "evidence matched",
            },
          ],
          artifacts: ["scenarios/negative-case/commands"],
        },
      ],
    };
    expect(validateInstallVmReleaseResult(result, releaseExpected)).toBe(result);
    expect(() =>
      validateInstallVmReleaseResult(result, {
        ...releaseExpected,
        sourceIdentity: "b".repeat(64),
      }),
    ).toThrow("current checkout identity");
    expect(() =>
      validateInstallVmReleaseResult(result, {
        ...releaseExpected,
        scenarios: [scenario, { ...scenario, id: "second-scenario", script: "second-scenario.sh" }],
      }),
    ).toThrow("complete scenario manifest");
    expect(() =>
      validateInstallVmReleaseResult(
        { ...result, run: { ...result.run, status: "skipped" } },
        releaseExpected,
      ),
    ).toThrow("not passed");
    expect(() =>
      validateInstallVmReleaseResult(
        {
          schemaVersion: 1,
          run: { sourceIdentity, status: "passed" },
          scenarios: [{ id: scenario.id, status: "passed" }],
        },
        releaseExpected,
      ),
    ).toThrow("malformed run metadata");
    expect(() =>
      validateInstallVmReleaseResult(
        {
          ...result,
          scenarios: [
            {
              ...result.scenarios[0],
              commands: [{ ...result.scenarios[0]!.commands[0], status: "failed" }],
            },
          ],
        },
        releaseExpected,
      ),
    ).toThrow("malformed command evidence");
    expect(() =>
      validateInstallVmReleaseResult(
        {
          ...result,
          scenarios: [
            {
              ...result.scenarios[0],
              commands: [
                {
                  ...result.scenarios[0]!.commands[0],
                  expectation: "looks successful",
                },
              ],
            },
          ],
        },
        releaseExpected,
      ),
    ).toThrow("unsupported expectation");

    for (const tools of [
      { ...result.tools, pnpm: "11.22.0" },
      { ...result.tools, npm: "" },
      { ...result.tools, extra: "unexpected" },
      Object.fromEntries(Object.entries(result.tools).filter(([key]) => key !== "kernel")),
    ]) {
      expect(() => validateInstallVmReleaseResult({ ...result, tools }, releaseExpected)).toThrow(
        "tool evidence",
      );
    }

    for (const scenarioEvidence of [
      { ...result.scenarios[0], artifacts: [".."] },
      { ...result.scenarios[0], observations: { dependencyTreePath: ".." } },
      {
        ...result.scenarios[0],
        commands: [{ ...result.scenarios[0]!.commands[0], logPath: ".." }],
      },
    ]) {
      expect(() =>
        validateInstallVmReleaseResult(
          { ...result, scenarios: [scenarioEvidence] },
          releaseExpected,
        ),
      ).toThrow("Unsafe install VM artifact path");
    }
  });

  test("rejects tampered authenticated daemon upgrade artifacts and observations", () => {
    const output = mkdtempSync(path.join(tmpdir(), "hunk-daemon-release-evidence-"));
    try {
      const { result, directory } = writeDaemonReleaseEvidence(output);
      const expected = {
        sourceIdentity,
        pnpmVersion: "11.23.0",
        scenarios: [daemonScenario],
        resultDirectory: output,
        daemonUpgradeBuildInputIdentity: "c".repeat(64),
        daemonRevision: 11,
        daemonUpgradeBinaryDigests: {
          binarySha256A: "a".repeat(64),
          binarySha256B: "b".repeat(64),
        },
      };
      expect(validateInstallVmReleaseResult(result, expected)).toBe(result);
      const mutate = (update: (copy: typeof result) => void) => {
        const copy = structuredClone(result);
        update(copy);
        return () => validateInstallVmReleaseResult(copy, expected);
      };

      expect(() =>
        mutate((copy) => {
          copy.scenarios[0]!.observations.daemonRevisionB = "10";
        })(),
      ).toThrow("revisions must be adjacent");
      expect(() =>
        mutate((copy) => {
          copy.scenarios[0]!.observations.daemonRevisionA = "1";
          copy.scenarios[0]!.observations.daemonRevisionB = "2";
        })(),
      ).toThrow("does not match this checkout");
      expect(() =>
        mutate((copy) => {
          copy.scenarios[0]!.observations.newDaemonPid = "100";
          copy.scenarios[0]!.observations.newDaemonStartToken = "1000";
        })(),
      ).toThrow("reused the incumbent process identity");
      expect(() =>
        mutate((copy) => {
          copy.scenarios[0]!.observations.newExecutableDigest = "a".repeat(64);
        })(),
      ).toThrow("digests are invalid or equal");
      expect(() =>
        mutate((copy) => {
          copy.scenarios[0]!.observations.reconnectDurationMs = "120001";
        })(),
      ).toThrow("duration exceeds its bound");

      writeFileSync(path.join(directory, "overlap-health.json"), '{"ok":true,"pid":100}');
      expect(() => validateInstallVmReleaseResult(result, expected)).toThrow(
        "not exact minimal health",
      );
      writeFileSync(path.join(directory, "overlap-health.json"), '{"ok":true}');
      writeFileSync(path.join(directory, "old-metadata.json"), '{"pid":999}');
      expect(() => validateInstallVmReleaseResult(result, expected)).toThrow(
        "PID does not match observations",
      );
      writeFileSync(path.join(directory, "old-metadata.json"), '{"pid":100}');
      writeFileSync(
        path.join(directory, "recovered-session-list.json"),
        '{"sessions":[{"pid":201}]}',
      );
      expect(() => validateInstallVmReleaseResult(result, expected)).toThrow(
        "not the original clients",
      );
      writeFileSync(
        path.join(directory, "recovered-session-list.json"),
        '{"sessions":[{"pid":201},{"pid":202}]}',
      );
      writeFileSync(
        path.join(directory, "old-executable.txt"),
        `pid=100\nstartToken=9999\nlocation=/fixture/a\ndigest=${"a".repeat(64)}\n`,
      );
      expect(() => validateInstallVmReleaseResult(result, expected)).toThrow(
        "does not match observations",
      );
      writeFileSync(
        path.join(directory, "old-executable.txt"),
        `pid=100\nstartToken=1000\nlocation=/fixture/a\ndigest=${"a".repeat(64)}\n`,
      );
      const fixtureManifestPath = path.join(directory, "daemon-fixture-manifest.json");
      const fixtureManifest = JSON.parse(readFileSync(fixtureManifestPath, "utf8"));
      fixtureManifest.daemonUpgrade.binarySha256A = "d".repeat(64);
      writeFileSync(fixtureManifestPath, JSON.stringify(fixtureManifest));
      expect(() => validateInstallVmReleaseResult(result, expected)).toThrow(
        "fixture manifest does not match",
      );
      fixtureManifest.daemonUpgrade.binarySha256A = "a".repeat(64);
      fixtureManifest.daemonUpgrade.extra = true;
      writeFileSync(fixtureManifestPath, JSON.stringify(fixtureManifest));
      expect(() => validateInstallVmReleaseResult(result, expected)).toThrow(
        "fixture manifest does not match",
      );
      delete fixtureManifest.daemonUpgrade.extra;
      writeFileSync(fixtureManifestPath, JSON.stringify(fixtureManifest));
      expect(() =>
        mutate((copy) => {
          copy.scenarios[0]!.commands[0]!.expectation = "exit 0";
          copy.scenarios[0]!.commands[0]!.exitCode = 1;
        })(),
      ).toThrow("impossible exit expectation");
      expect(() =>
        mutate((copy) => {
          copy.scenarios[0]!.commands[0]!.expectation = "observed exit";
          copy.scenarios[0]!.commands[0]!.exitCode = 97;
        })(),
      ).toThrow("command upgrade-daemon-b expected exit 0");

      const coherentlyTampered = structuredClone(result);
      coherentlyTampered.scenarios[0]!.observations.oldExecutableDigest = "d".repeat(64);
      coherentlyTampered.scenarios[0]!.observations.newExecutableDigest = "e".repeat(64);
      writeFileSync(
        path.join(directory, "old-executable.txt"),
        `pid=100\nstartToken=1000\nlocation=/fixture/a\ndigest=${"d".repeat(64)}\n`,
      );
      writeFileSync(
        path.join(directory, "new-executable.txt"),
        `pid=200\nstartToken=2000\nlocation=/fixture/b\ndigest=${"e".repeat(64)}\n`,
      );
      fixtureManifest.daemonUpgrade.binarySha256A = "d".repeat(64);
      fixtureManifest.daemonUpgrade.binarySha256B = "e".repeat(64);
      writeFileSync(fixtureManifestPath, JSON.stringify(fixtureManifest));
      expect(() => validateInstallVmReleaseResult(coherentlyTampered, expected)).toThrow(
        "fixture manifest does not match",
      );
      writeFileSync(
        path.join(directory, "old-executable.txt"),
        `pid=100\nstartToken=1000\nlocation=/fixture/a\ndigest=${"a".repeat(64)}\n`,
      );
      writeFileSync(
        path.join(directory, "new-executable.txt"),
        `pid=200\nstartToken=2000\nlocation=/fixture/b\ndigest=${"b".repeat(64)}\n`,
      );
      fixtureManifest.daemonUpgrade.binarySha256A = "a".repeat(64);
      fixtureManifest.daemonUpgrade.binarySha256B = "b".repeat(64);
      writeFileSync(fixtureManifestPath, JSON.stringify(fixtureManifest));

      const outside = path.join(output, "outside-health.json");
      writeFileSync(outside, '{"ok":true}');
      unlinkSync(path.join(directory, "overlap-health.json"));
      symlinkSync(outside, path.join(directory, "overlap-health.json"));
      expect(() => validateInstallVmReleaseResult(result, expected)).toThrow(
        "may not be a symlink",
      );
      unlinkSync(path.join(directory, "overlap-health.json"));
      symlinkSync("recovered-health.json", path.join(directory, "overlap-health.json"));
      expect(() => validateInstallVmReleaseResult(result, expected)).toThrow(
        "may not be a symlink",
      );
      unlinkSync(path.join(directory, "overlap-health.json"));
      writeFileSync(path.join(directory, "overlap-health.json"), '{"ok":true}');

      unlinkSync(path.join(directory, "recovered-health.json"));
      expect(() => validateInstallVmReleaseResult(result, expected)).toThrow(
        "references missing artifact",
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("enforces scenario-specific required evidence during aggregation and release validation", () => {
    const output = mkdtempSync(path.join(tmpdir(), "hunk-install-vm-required-"));
    const requiredScenario = {
      ...scenario,
      requiredEvidence: {
        commands: ["upgrade"],
        commandExpectations: { upgrade: "exit 0" },
        assertions: ["daemon-preserved"],
        observations: ["daemonPid", "transcriptPath"],
      },
    };
    try {
      const scenarioDir = path.join(output, "scenarios", scenario.id);
      mkdirSync(path.join(scenarioDir, "commands"), { recursive: true });
      writeFileSync(
        path.join(scenarioDir, "result.json"),
        `${JSON.stringify({ id: scenario.id, exitCode: 0, durationMs: 10 })}\n`,
      );
      writeFileSync(
        path.join(scenarioDir, "commands.tsv"),
        "upgrade\tpassed\texit 0\t0\tcommands/upgrade.log\n",
      );
      writeFileSync(path.join(scenarioDir, "commands", "upgrade.log"), "ok\n");
      writeFileSync(
        path.join(scenarioDir, "assertions.tsv"),
        "daemon-preserved\tpassed\talive\talive\told daemon survived\n",
      );
      writeFileSync(path.join(scenarioDir, "transcript.log"), "transcript\n");
      writeFileSync(
        path.join(scenarioDir, "observations.tsv"),
        "daemonPid\t123\ntranscriptPath\ttranscript.log\n",
      );
      const aggregated = aggregateInstallVmResults({
        outputDir: output,
        runId: "run",
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:00:01Z",
        sourceIdentity,
        scenarios: [requiredScenario],
        tools: {},
      });
      expect(aggregated.run.status).toBe("passed");

      writeFileSync(path.join(scenarioDir, "observations.tsv"), "daemonPid\t123\n");
      expect(
        aggregateInstallVmResults({
          outputDir: output,
          runId: "run",
          startedAt: "2026-01-01T00:00:00Z",
          finishedAt: "2026-01-01T00:00:01Z",
          sourceIdentity,
          scenarios: [requiredScenario],
          tools: {},
        }).run.status,
      ).toBe("failed");

      const releaseExpected = {
        sourceIdentity,
        pnpmVersion: "11.23.0",
        scenarios: [requiredScenario],
      };
      const release = {
        ...aggregated,
        tools: {
          firecracker: "Firecracker v1.16.1",
          kernel: "6.18.44",
          node: "v24.14.1",
          npm: "11.11.0",
          pnpm: releaseExpected.pnpmVersion,
          verdaccio: "v6.10.1",
        },
      };
      expect(validateInstallVmReleaseResult(release, releaseExpected)).toBe(release);
      const missing = {
        ...release,
        scenarios: [
          {
            ...release.scenarios[0]!,
            observations: { daemonPid: "123" },
          },
        ],
      };
      expect(() => validateInstallVmReleaseResult(missing, releaseExpected)).toThrow(
        "required observation transcriptPath",
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("writes deterministic JSON and JUnit projections", () => {
    const output = mkdtempSync(path.join(tmpdir(), "hunk-install-vm-result-"));
    try {
      const scenarioDir = path.join(output, "scenarios", scenario.id);
      mkdirSync(scenarioDir, { recursive: true });
      writeFileSync(
        path.join(scenarioDir, "result.json"),
        `${JSON.stringify({ id: scenario.id, exitCode: 0, durationMs: 10 })}\n`,
      );
      writeFileSync(
        path.join(scenarioDir, "assertions.tsv"),
        "expected-negative\tpassed\tnonzero\texit 1\tfailure was expected\n",
      );
      writeFileSync(
        path.join(scenarioDir, "commands.tsv"),
        "expected-negative\tpassed\tnonzero exit\t1\tcommands/expected-negative.log\n",
      );
      mkdirSync(path.join(scenarioDir, "commands"));
      writeFileSync(path.join(scenarioDir, "commands", "expected-negative.log"), "expected\n");
      writeFileSync(path.join(scenarioDir, "observations.tsv"), "hunkVersion\t1.2.3\n");
      writeFileSync(path.join(scenarioDir, "guest.log"), "evidence\n");
      writeFileSync(path.join(scenarioDir, "secret.ext4"), "excluded\n");

      const result = aggregateInstallVmResults({
        outputDir: output,
        runId: "run",
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:00:01Z",
        sourceIdentity,
        scenarios: [scenario],
        tools: { zeta: "2", alpha: "1" },
      });

      expect(result.run.status).toBe("passed");
      expect(result.run.sourceIdentity).toBe(sourceIdentity);
      expect(Object.keys(result.tools)).toEqual(["alpha", "zeta"]);
      expect(result.scenarios[0]?.commands[0]?.exitCode).toBe(1);
      expect(result.scenarios[0]?.observations.hunkVersion).toBe("1.2.3");
      expect(result.scenarios[0]?.artifacts).not.toContain("scenarios/negative-case/secret.ext4");
      expect(readFileSync(path.join(output, "result.json"), "utf8")).toEndWith("\n");
      expect(readFileSync(path.join(output, "junit.xml"), "utf8")).toContain('failures="0"');
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("fails vacuous zero-exit scenarios and rejects fractional raw values", () => {
    const output = mkdtempSync(path.join(tmpdir(), "hunk-install-vm-vacuous-"));
    try {
      const scenarioDir = path.join(output, "scenarios", scenario.id);
      mkdirSync(scenarioDir, { recursive: true });
      writeFileSync(
        path.join(scenarioDir, "result.json"),
        `${JSON.stringify({ id: scenario.id, exitCode: 0, durationMs: 10 })}\n`,
      );
      writeFileSync(path.join(scenarioDir, "assertions.tsv"), "");
      writeFileSync(path.join(scenarioDir, "commands.tsv"), "");
      writeFileSync(path.join(scenarioDir, "observations.tsv"), "");
      expect(
        aggregateInstallVmResults({
          outputDir: output,
          runId: "run",
          startedAt: "2026-01-01T00:00:00Z",
          finishedAt: "2026-01-01T00:00:01Z",
          sourceIdentity,
          scenarios: [scenario],
          tools: {},
        }).run.status,
      ).toBe("failed");

      writeFileSync(
        path.join(scenarioDir, "result.json"),
        `${JSON.stringify({ id: scenario.id, exitCode: 0.5, durationMs: 10 })}\n`,
      );
      expect(() =>
        aggregateInstallVmResults({
          outputDir: output,
          runId: "run",
          startedAt: "2026-01-01T00:00:00Z",
          finishedAt: "2026-01-01T00:00:01Z",
          sourceIdentity,
          scenarios: [scenario],
          tools: {},
        }),
      ).toThrow("Malformed raw scenario result");
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
