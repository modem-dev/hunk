import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
