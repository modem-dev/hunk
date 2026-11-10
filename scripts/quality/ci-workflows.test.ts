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
  test("shards Windows tests without replacing either platform test group", () => {
    const workflow = readTestWorkflow(".github/workflows/pr-ci.yml");
    const tests = workflow.jobs["windows-compat"]!.steps.find(
      (step) => step.name === "Windows platform test suite",
    );
    expect(tests?.run).toBe("bun run test:windows");
    expect(tests?.env?.HUNK_TEST_SHARDS).toBe("2");
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
    const installs = runs!.steps.filter((step) => step.run?.includes("bun install"));
    expect(installs).toHaveLength(2);
    for (const step of installs) {
      expect(step.run).toBe("bun install --frozen-lockfile");
      expect(step.env?.BUN_INSTALL_CACHE_DIR).toBe("${{ runner.temp }}/bun-install-cache");
    }
  });

  for (const name of ["pr-ci", "ci", "nix", "website"]) {
    test(`${name} cancels superseded runs without colliding across PR refs`, () => {
      const { concurrency } = readTestWorkflow(`.github/workflows/${name}.yml`);
      expect(concurrency?.["cancel-in-progress"]).toBe(true);
      expect(concurrency?.group).toContain("github.ref");
    });
  }
});
