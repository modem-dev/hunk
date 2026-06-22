// Optional informational comparisons against diff-oriented CLI tools when installed.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "perf_hooks";
import {
  createChangedRepo,
  createSyntheticPatch,
  createSyntheticSource,
  createTemporaryDirectory,
  git,
} from "./lib/fixtures";

interface ToolScenario {
  metric: string;
  command: string[];
  stdin?: string;
  cwd?: string;
}

function commandExists(command: string) {
  const proc = Bun.spawnSync(["sh", "-c", `command -v ${command} >/dev/null 2>&1`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exitCode === 0;
}

function measureTool({ metric, command, stdin, cwd }: ToolScenario) {
  const start = performance.now();
  const proc = Bun.spawnSync(command, {
    cwd,
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", TERM: "xterm-256color" },
  });
  const duration = performance.now() - start;

  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr).toString("utf8").trim();
    console.log(`METRIC ${metric}_available=0`);
    if (stderr) {
      console.warn(`${command.join(" ")} failed: ${stderr}`);
    }
    return;
  }

  console.log(`METRIC ${metric}_ms=${duration.toFixed(2)}`);
  console.log(`METRIC ${metric}_available=1`);
}

const patch = createSyntheticPatch({ fileCount: 96, lines: 180, changedLines: 36 });
const patchFixture = createTemporaryDirectory("hunk-competitor-patch-");
const repoFixture = createChangedRepo({ fileCount: 96, lines: 180, changedLines: 36 });

try {
  const patchPath = join(patchFixture.path, "large.patch");
  const beforePath = join(patchFixture.path, "before.ts");
  const afterPath = join(patchFixture.path, "after.ts");
  writeFileSync(patchPath, patch);
  writeFileSync(
    beforePath,
    createSyntheticSource(1, false, { lines: 12_000, changedLines: 2_000 }),
  );
  writeFileSync(afterPath, createSyntheticSource(1, true, { lines: 12_000, changedLines: 2_000 }));

  measureTool({
    metric: "competitor_git_diff_no_ext_diff",
    command: ["git", "diff", "--no-ext-diff", "--no-color"],
    cwd: repoFixture.path,
  });

  // Warm git's object lookup so the metric above still validates the fixture even if not compared.
  git(repoFixture.path, "status", "--short");

  if (commandExists("delta")) {
    measureTool({
      metric: "competitor_delta_patch_stdin",
      command: ["delta", "--no-gitconfig", "--paging=never"],
      stdin: patch,
    });
  } else {
    console.log("METRIC competitor_delta_patch_stdin_available=0");
  }

  if (commandExists("difft")) {
    measureTool({
      metric: "competitor_difftastic_file_pair",
      command: ["difft", "--color=never", beforePath, afterPath],
    });
  } else if (commandExists("difftastic")) {
    measureTool({
      metric: "competitor_difftastic_file_pair",
      command: ["difftastic", "--color=never", beforePath, afterPath],
    });
  } else {
    console.log("METRIC competitor_difftastic_file_pair_available=0");
  }

  if (commandExists("diff-so-fancy")) {
    measureTool({
      metric: "competitor_diff_so_fancy_patch_stdin",
      command: ["diff-so-fancy"],
      stdin: patch,
    });
  } else {
    console.log("METRIC competitor_diff_so_fancy_patch_stdin_available=0");
  }
} finally {
  patchFixture.cleanup();
  repoFixture.cleanup();
}
