import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface TestWorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
}

interface TestWorkflowJob {
  needs?: string | string[];
  if?: string;
  steps: TestWorkflowStep[];
  env?: Record<string, string>;
  strategy?: { "fail-fast": boolean; matrix: { shard: number[] } };
}

/** Read checked-in workflow contracts without executing a GitHub runner. */
function readTestWorkflow(relativePath: string) {
  return Bun.YAML.parse(readFileSync(resolve(import.meta.dir, "../..", relativePath), "utf8")) as {
    concurrency?: { "cancel-in-progress": boolean; group: string };
    jobs: Record<string, TestWorkflowJob>;
    runs?: { steps: TestWorkflowStep[] };
  };
}

describe("non-PTY CI contracts", () => {
  test("partitions both Windows groups across isolated runners and gates on all results", () => {
    const { jobs } = readTestWorkflow(".github/workflows/pr-ci.yml");
    const tests = jobs["windows-tests"]!;
    expect(tests.strategy?.matrix.shard).toEqual([1, 2]);
    expect(tests.strategy?.["fail-fast"]).toBe(false);
    expect(tests.env?.HUNK_TEST_SHARDS).toBe("1");
    const commands = tests.steps.map((step) => step.run);
    for (const group of ["windows", "windows-ui"]) {
      expect(commands).toContain(
        `bun run ./scripts/test/run-test-suite.ts --group=${group} --shard=\${{ matrix.shard }}/2`,
      );
    }
    const checks = jobs["windows-checks"]!.steps.map((step) => step.run);
    for (const script of [
      "format:check",
      "lint",
      "typecheck",
      "deps:check",
      "test:theme-contrast",
    ]) {
      expect(checks).toContain(`bun run ${script}`);
    }
    const gate = jobs["windows-compat"]!;
    expect(gate.needs).toEqual(["changes", "windows-checks", "windows-tests"]);
    expect(gate.if).toBe("always()");
    expect(gate.steps[0]?.run).toContain('$CHECKS_RESULT" != "success"');
    expect(gate.steps[0]?.run).toContain('$TESTS_RESULT" != "success"');
    expect(gate.steps[0]?.run).toContain('$CHANGES_RESULT" != "success"');
  });

  test("runs Linux validation and packaging independently and gates on both", () => {
    const { jobs } = readTestWorkflow(".github/workflows/pr-ci.yml");
    for (const name of ["linux-validate", "linux-packaging"]) {
      expect(jobs[name]?.needs).toBe("changes");
      expect(jobs[name]?.if).toBe("needs.changes.outputs.code == 'true'");
      expect(jobs["pr-validate"]?.needs).toContain(name);
    }
    const validation = jobs["linux-validate"]!.steps.map((step) => step.run).join("\n");
    expect(validation).toContain("bun run test\n");
    expect(validation).toContain("bun run test:session-broker-node");
    expect(validation).toContain("bun run test:tty-smoke");

    const gate = jobs["pr-validate"]!.steps[0]!;
    expect(gate.env?.PACKAGING_RESULT).toBe("${{ needs.linux-packaging.result }}");
    expect(gate.run).toContain('$PACKAGING_RESULT" != "success"');
    expect(gate.run).toContain('$LINUX_RESULT" != "success"');
    expect(gate.run).toContain('$PTY_RESULT" != "success"');
  });

  test("caches downloads but always installs frozen dependencies", () => {
    const { runs } = readTestWorkflow(".github/actions/bun-install/action.yml");
    const text = JSON.stringify(runs);
    expect(text).toContain("bun-install-cache");
    expect(text).not.toContain("node_modules");
    expect(runs!.steps[0]?.run).toBe(
      'echo "BUN_INSTALL_CACHE_DIR=$RUNNER_TEMP/bun-install-cache" >> "$GITHUB_ENV"',
    );
    const installs = runs!.steps.filter((step) => step.run?.includes("bun install"));
    expect(installs).toHaveLength(2);
    for (const step of installs) {
      expect(step.run).toBe("bun install --frozen-lockfile");
      expect(step.env?.BUN_INSTALL_CACHE_DIR).toBe("${{ runner.temp }}/bun-install-cache");
    }
  });

  test("always runs every Nix evaluation and package build check", () => {
    const { jobs } = readTestWorkflow(".github/workflows/nix.yml");
    const steps = jobs.package!.steps;
    for (const command of [
      "nix flake check --print-build-logs",
      "nix flake check --all-systems --no-build",
      "nix build .#default --print-build-logs",
    ]) {
      const step = steps.find((candidate) => candidate.run === command);
      expect(step).toBeDefined();
      expect(step).not.toHaveProperty("if");
    }
  });

  test("installs the headless browser while keeping all website browser projects", () => {
    const { jobs } = readTestWorkflow(".github/workflows/website.yml");
    const step = jobs.build!.steps.find(
      (candidate) => candidate.name === "Run browser smoke tests",
    );
    expect(step?.run).toBe("bun run website:test:browser --workers=4");
    const install = jobs.build!.steps.find((candidate) => candidate.name === "Install Chromium");
    expect(install?.run).toBe(
      "cd website && bunx playwright install --with-deps --only-shell chromium",
    );
  });

  for (const name of ["pr-ci", "ci", "nix", "website"]) {
    test(`${name} cancels superseded runs without colliding across PR refs`, () => {
      const { concurrency } = readTestWorkflow(`.github/workflows/${name}.yml`);
      expect(concurrency?.["cancel-in-progress"]).toBe(true);
      expect(concurrency?.group).toContain("github.ref");
    });
  }
});
