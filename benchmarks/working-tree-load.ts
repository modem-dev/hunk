// Benchmark git-backed working-tree loading, including untracked file handling.
import { performance } from "perf_hooks";
import { loadAppBootstrap } from "../src/core/loaders";
import { addUntrackedFiles, createChangedRepo } from "./lib/fixtures";

interface Scenario {
  name: string;
  fileCount: number;
  lines: number;
  untrackedFiles?: number;
  untrackedLines?: number;
}

const scenarios: Scenario[] = [
  { name: "small_worktree", fileCount: 16, lines: 80 },
  { name: "medium_worktree", fileCount: 96, lines: 180 },
  { name: "large_worktree", fileCount: 240, lines: 220 },
  {
    name: "untracked_many_small",
    fileCount: 16,
    lines: 80,
    untrackedFiles: 120,
    untrackedLines: 36,
  },
  {
    name: "untracked_few_large",
    fileCount: 8,
    lines: 80,
    untrackedFiles: 6,
    untrackedLines: 5_000,
  },
];

async function measureScenario(scenario: Scenario) {
  const fixture = createChangedRepo({ fileCount: scenario.fileCount, lines: scenario.lines });

  try {
    if (scenario.untrackedFiles) {
      addUntrackedFiles(fixture.path, scenario.untrackedFiles, scenario.untrackedLines ?? 40);
    }

    const start = performance.now();
    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "auto" } },
      { cwd: fixture.path },
    );
    const loadMs = performance.now() - start;
    const additions = bootstrap.changeset.files.reduce(
      (sum, file) => sum + file.stats.additions,
      0,
    );
    const deletions = bootstrap.changeset.files.reduce(
      (sum, file) => sum + file.stats.deletions,
      0,
    );

    console.log(`METRIC ${scenario.name}_load_ms=${loadMs.toFixed(2)}`);
    console.log(`METRIC ${scenario.name}_files=${bootstrap.changeset.files.length}`);
    console.log(`METRIC ${scenario.name}_additions=${additions}`);
    console.log(`METRIC ${scenario.name}_deletions=${deletions}`);
  } finally {
    fixture.cleanup();
  }
}

for (const scenario of scenarios) {
  await measureScenario(scenario);
}
