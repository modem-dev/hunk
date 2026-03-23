// Measure `loadAppBootstrap()` on a larger synthetic repo and print both
// end-to-end timing and a few git-loader phase probes for hotspot hunting.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "perf_hooks";
import { parsePatchFiles } from "@pierre/diffs";
import { loadAppBootstrap } from "../src/core/loaders";

const FILE_COUNT = 64;
const LINES_PER_FILE = 420;
const CHANGED_START = 120;
const CHANGED_END = 300;

function git(cwd: string, ...cmd: string[]) {
  const proc = Bun.spawnSync(["git", ...cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr).toString("utf8");
    throw new Error(stderr.trim() || `git ${cmd.join(" ")} failed`);
  }

  return Buffer.from(proc.stdout).toString("utf8");
}

function createFileContents(fileIndex: number, changed: boolean) {
  return Array.from({ length: LINES_PER_FILE }, (_, lineIndex) => {
    const line = lineIndex + 1;

    if (changed && lineIndex >= CHANGED_START && lineIndex < CHANGED_END) {
      return `export function feature${fileIndex}_${line}(value: number) { return value * ${line} + ${fileIndex}; }\n`;
    }

    return `export function feature${fileIndex}_${line}(value: number) { return value + ${line}; }\n`;
  }).join("");
}

function splitPatchIntoFileChunks(rawPatch: string) {
  const patch = rawPatch.replaceAll("\r\n", "\n");
  const lines = patch.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  const hasGitHeaders = lines.some((line) => line.startsWith("diff --git "));

  const flush = () => {
    if (current.length > 0) {
      chunks.push(`${current.join("\n").trimEnd()}\n`);
      current = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    if (hasGitHeaders && line.startsWith("diff --git ")) {
      flush();
      current.push(line);
      continue;
    }

    if (!hasGitHeaders && line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      flush();
      current.push(line);
      current.push(lines[index + 1]!);
      index += 1;
      continue;
    }

    if (current.length > 0) {
      current.push(line);
    }
  }

  flush();
  return chunks;
}

function createWorkingTreeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-bootstrap-benchmark-"));

  git(dir, "init");
  git(dir, "config", "user.name", "Benchmark User");
  git(dir, "config", "user.email", "benchmark@example.com");

  for (let index = 1; index <= FILE_COUNT; index += 1) {
    writeFileSync(join(dir, `file${index}.ts`), createFileContents(index, false));
  }

  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial");

  for (let index = 1; index <= FILE_COUNT; index += 1) {
    writeFileSync(join(dir, `file${index}.ts`), createFileContents(index, true));
  }

  return dir;
}

async function measureGitBootstrap(repoDir: string) {
  const previousCwd = process.cwd();
  process.chdir(repoDir);

  try {
    const endToEndStart = performance.now();
    const bootstrap = await loadAppBootstrap({
      kind: "git",
      staged: false,
      options: { mode: "auto" },
    });
    const endToEndMs = performance.now() - endToEndStart;

    const gitDiffStart = performance.now();
    const patchText = git(repoDir, "diff", "--no-ext-diff", "--find-renames", "--no-color");
    const gitDiffMs = performance.now() - gitDiffStart;

    const parseStart = performance.now();
    const parsedPatches = parsePatchFiles(patchText, "patch", true);
    const parsePatchMs = performance.now() - parseStart;

    const splitStart = performance.now();
    const chunks = splitPatchIntoFileChunks(patchText);
    const splitChunksMs = performance.now() - splitStart;

    return {
      endToEndMs,
      gitDiffMs,
      parsePatchMs,
      splitChunksMs,
      files: bootstrap.changeset.files.length,
      parsedFiles: parsedPatches.flatMap((entry) => entry.files).length,
      patchChunks: chunks.length,
    };
  } finally {
    process.chdir(previousCwd);
  }
}

async function measureFilePairBootstrap(repoDir: string) {
  const left = join(repoDir, "before.ts");
  const right = join(repoDir, "after.ts");

  writeFileSync(left, createFileContents(999, false));
  writeFileSync(right, createFileContents(999, true));

  const start = performance.now();
  const bootstrap = await loadAppBootstrap({
    kind: "diff",
    left,
    right,
    options: { mode: "auto" },
  });
  const duration = performance.now() - start;

  return {
    duration,
    files: bootstrap.changeset.files.length,
  };
}

const repoDir = createWorkingTreeRepo();

try {
  const gitResult = await measureGitBootstrap(repoDir);
  const diffResult = await measureFilePairBootstrap(repoDir);

  console.log(`METRIC git_bootstrap_ms=${gitResult.endToEndMs.toFixed(2)}`);
  console.log(`METRIC git_diff_subprocess_ms=${gitResult.gitDiffMs.toFixed(2)}`);
  console.log(`METRIC git_parse_patch_ms=${gitResult.parsePatchMs.toFixed(2)}`);
  console.log(`METRIC git_split_patch_chunks_ms=${gitResult.splitChunksMs.toFixed(2)}`);
  console.log(`METRIC file_pair_bootstrap_ms=${diffResult.duration.toFixed(2)}`);
  console.log(`METRIC files=${gitResult.files}`);
  console.log(`METRIC parsed_files=${gitResult.parsedFiles}`);
  console.log(`METRIC patch_chunks=${gitResult.patchChunks}`);
  console.log(`METRIC lines_per_file=${LINES_PER_FILE}`);
} finally {
  rmSync(repoDir, { recursive: true, force: true });
}
