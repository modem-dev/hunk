import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTwoFilesPatch } from "diff";

export interface SyntheticFileOptions {
  lines: number;
  changedStart?: number;
  changedLines?: number;
  extension?: string;
}

export interface SyntheticPatchOptions extends SyntheticFileOptions {
  fileCount: number;
  prefix?: string;
}

export interface TemporaryDirectory {
  path: string;
  cleanup: () => void;
}

/** Create a temporary directory with a cleanup helper for benchmark fixtures. */
export function createTemporaryDirectory(prefix: string): TemporaryDirectory {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

/** Run git in a benchmark fixture and throw with stderr on failure. */
export function git(cwd: string, ...cmd: string[]) {
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

/** Generate deterministic TypeScript-like contents with a controlled changed region. */
export function createSyntheticSource(
  fileIndex: number,
  changed: boolean,
  options: SyntheticFileOptions,
) {
  const changedStart = options.changedStart ?? Math.floor(options.lines / 3);
  const changedEnd =
    changedStart + (options.changedLines ?? Math.max(4, Math.floor(options.lines / 6)));

  return Array.from({ length: options.lines }, (_, lineIndex) => {
    const line = lineIndex + 1;
    if (changed && lineIndex >= changedStart && lineIndex < changedEnd) {
      return `export function bench${fileIndex}_${line}(value: number) { return value * ${line} + ${fileIndex}; }\n`;
    }

    return `export function bench${fileIndex}_${line}(value: number) { return value + ${line}; }\n`;
  }).join("");
}

/** Build one deterministic multi-file unified patch. */
export function createSyntheticPatch({
  fileCount,
  lines,
  changedStart,
  changedLines,
  extension = "ts",
  prefix = "src/bench",
}: SyntheticPatchOptions) {
  return Array.from({ length: fileCount }, (_, index) => {
    const fileIndex = index + 1;
    const path = `${prefix}${fileIndex}.${extension}`;
    const before = createSyntheticSource(fileIndex, false, { lines, changedStart, changedLines });
    const after = createSyntheticSource(fileIndex, true, { lines, changedStart, changedLines });

    const patch = createTwoFilesPatch(path, path, before, after, "", "", { context: 3 });
    // Pierre's patch parser expects unified/git hunks; remove diff-package index banners.
    return patch.replace(/^Index: .*\n=+\n/, "").trimEnd();
  }).join("\n");
}

/** Create a git repo with committed files and modified tracked contents. */
export function createChangedRepo({
  fileCount,
  lines,
  changedStart,
  changedLines,
  extension = "ts",
}: SyntheticPatchOptions) {
  const fixture = createTemporaryDirectory("hunk-benchmark-repo-");

  git(fixture.path, "init");
  git(fixture.path, "config", "user.name", "Benchmark User");
  git(fixture.path, "config", "user.email", "benchmark@example.com");

  for (let index = 1; index <= fileCount; index += 1) {
    const relativePath = join("src", `bench${index}.${extension}`);
    const absolutePath = join(fixture.path, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(
      absolutePath,
      createSyntheticSource(index, false, { lines, changedStart, changedLines }),
    );
  }

  git(fixture.path, "add", ".");
  git(fixture.path, "commit", "-m", "initial benchmark fixture");

  for (let index = 1; index <= fileCount; index += 1) {
    const relativePath = join("src", `bench${index}.${extension}`);
    writeFileSync(
      join(fixture.path, relativePath),
      createSyntheticSource(index, true, { lines, changedStart, changedLines }),
    );
  }

  return fixture;
}

/** Add deterministic untracked files to an existing benchmark repository. */
export function addUntrackedFiles(repoDir: string, fileCount: number, lines: number) {
  for (let index = 1; index <= fileCount; index += 1) {
    const relativePath = join("untracked", `new${index}.ts`);
    const absolutePath = join(repoDir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, createSyntheticSource(index, true, { lines }));
  }
}
