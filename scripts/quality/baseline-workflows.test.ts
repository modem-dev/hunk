import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface WorkflowJob {
  "runs-on": string;
  strategy?: {
    matrix: { include: Array<{ package_name: string; runner: string }> };
  };
  steps: Array<{ name?: string; if?: string; run?: string }>;
}

/** Read the real workflow so runner changes cannot silently invalidate CPU emulation. */
function readTestWorkflow(filename: string) {
  const source = readFileSync(
    path.resolve(import.meta.dir, "../../.github/workflows", filename),
    "utf8",
  );
  return Bun.YAML.parse(source) as { jobs: Record<string, WorkflowJob> };
}

describe("baseline CPU workflow environments", () => {
  test("main checks the binary on Nehalem with an older-CPU-compatible userland", () => {
    const job = readTestWorkflow("ci.yml").jobs["build-bin"]!;
    expect(job["runs-on"]).toBe("ubuntu-24.04");

    const probe = job.steps.find((step) => step.name === "Verify the binary starts without AVX2");
    expect(probe?.run).toContain("qemu-x86_64 -cpu Nehalem dist/hunk --version");
    expect(probe?.if).toBeUndefined();
  });

  test("release checks the Linux x64 artifact with the same compatible userland", () => {
    const job = readTestWorkflow("release-prebuilt-npm.yml").jobs["build-binaries"]!;
    const target = job.strategy?.matrix.include.find(
      (entry) => entry.package_name === "hunkdiff-linux-x64",
    );
    expect(target?.runner).toBe("ubuntu-24.04");

    const probe = job.steps.find(
      (step) => step.name === "Verify the x64 artifact starts without AVX2",
    );
    expect(probe?.run).toContain("qemu-x86_64 -cpu Nehalem dist/hunk --version");
    expect(probe?.if).toBe("matrix.package_name == 'hunkdiff-linux-x64'");
  });
});
