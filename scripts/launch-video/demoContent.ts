// Demo repositories and generated source for the capture scenes.
//
// Every line number and character offset a scene points at is computed from
// this generated content (`locateNeedle`), never hand-counted — regenerating
// the module keeps the shots aimed at the right code.
import { cpSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** Runs one git command in a demo repo, throwing on failure. */
export function runGit(args: string[], cwd: string) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (proc.status !== 0) {
    throw new Error(proc.stderr.trim() || `git ${args.join(" ")} failed`);
  }
}

export interface DemoRepoOptions {
  /** Hunk's repo root, source of the `examples/` trees. */
  repoRoot: string;
  /** Scratch-dir factory owned by the caller so temp cleanup stays in one place. */
  makeTempDir: (prefix: string) => string;
}

/**
 * Generates a deterministic long module: 72 one-line team policies with a
 * quarterly recalibration sprinkled through them, and one behavioral
 * comparator change buried in the helper below the table.
 */
export function buildReportModule(variant: "before" | "after") {
  const areas = [
    "activation",
    "billing",
    "checkout",
    "growth",
    "identity",
    "messaging",
    "mobile",
    "onboarding",
    "payments",
    "platform",
    "search",
    "support",
  ];
  const regions = ["us-east", "us-west", "eu-west", "eu-north", "apac-sg", "apac-syd"];
  const owners = ["dana", "kai", "mira", "theo", "noor", "felix", "iris", "remy"];

  const entries: string[] = [];
  let index = 0;
  for (const area of areas) {
    for (const region of regions) {
      // Every third entry gets its limit recalibrated — mechanical churn that
      // keeps the whole table one tall hunk without touching every line.
      const bump = variant === "after" && index % 3 === 0 ? 2 : 0;
      const limit = 4 + (index % 9) + bump;
      const escalate = 1 + (index % 5);
      entries.push(
        `  { team: "${area}-${region}", owner: "${owners[index % owners.length]}", limit: ${limit}, escalateAfterDays: ${escalate} },`,
      );
      index += 1;
    }
  }

  // The buried behavioral change: at-limit teams now count as overloaded.
  const comparator = variant === "after" ? ">=" : ">";
  const lines = [
    "/** Weekly workload policies per team, consumed by the ops report. */",
    "export interface TeamPolicy {",
    "  team: string;",
    "  owner: string;",
    "  limit: number;",
    "  escalateAfterDays: number;",
    "}",
    "",
    "export const TEAM_POLICIES: TeamPolicy[] = [",
    ...entries,
    "];",
    "",
    "/** Flags a team as overloaded once open work reaches its limit. */",
    "export function isOverloaded(openCount: number, policy: TeamPolicy) {",
    `  return openCount ${comparator} policy.limit;`,
    "}",
    "",
  ];
  return lines.join("\n");
}

/**
 * Builds a real git repo from the mini-app refactor example: commits the
 * "before" tree, overlays the "after" tree as the working diff.
 */
export function createDemoRepo(options: DemoRepoOptions) {
  const repoDir = options.makeTempDir("hunk-video-repo-");
  initDemoRepo(repoDir);
  cpSync(join(options.repoRoot, "examples/2-mini-app-refactor/before"), repoDir, {
    recursive: true,
  });
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "before"], repoDir);
  cpSync(join(options.repoRoot, "examples/2-mini-app-refactor/after"), repoDir, {
    recursive: true,
  });
  return repoDir;
}

/**
 * Builds the agent scene's repo: the mini-app refactor plus the long report
 * module, whose buried comparator is the target only a line-exact command can
 * reach.
 */
export function createAgentDemoRepo(options: DemoRepoOptions) {
  const repoDir = options.makeTempDir("hunk-video-repo-");
  initDemoRepo(repoDir);
  cpSync(join(options.repoRoot, "examples/2-mini-app-refactor/before"), repoDir, {
    recursive: true,
  });
  writeFileSync(join(repoDir, "src/report.ts"), buildReportModule("before"));
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "before"], repoDir);
  cpSync(join(options.repoRoot, "examples/2-mini-app-refactor/after"), repoDir, {
    recursive: true,
  });
  writeFileSync(join(repoDir, "src/report.ts"), buildReportModule("after"));
  return repoDir;
}

/** Initializes a git repo with a fixed identity so commits never prompt. */
function initDemoRepo(repoDir: string) {
  runGit(["init"], repoDir);
  runGit(["config", "user.name", "Demo"], repoDir);
  runGit(["config", "user.email", "demo@example.com"], repoDir);
}

/** Finds the 1-based line and [start, end) offsets of `needle` in module text. */
export function locateNeedle(moduleText: string, needle: string) {
  const lines = moduleText.split("\n");
  const lineIndex = lines.findIndex((line) => line.includes(needle));
  if (lineIndex === -1) throw new Error(`needle not found: ${needle}`);
  const start = lines[lineIndex]!.indexOf(needle);
  return { line: lineIndex + 1, start, end: start + needle.length };
}
