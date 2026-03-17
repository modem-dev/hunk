import {
  getFiletypeFromFileName,
  parseDiffFromFile,
  parsePatchFiles,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import { findAgentFileContext, loadAgentContext } from "./agent";
import type {
  AppBootstrap,
  AgentContext,
  Changeset,
  CliInput,
  DiffFile,
  DiffToolCommandInput,
  FileCommandInput,
  GitCommandInput,
  PatchCommandInput,
} from "./types";

function spawnText(cmd: string[], cwd = process.cwd()) {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(proc.stdout).toString("utf8");
  const stderr = Buffer.from(proc.stderr).toString("utf8");

  if (proc.exitCode !== 0) {
    throw new Error(stderr.trim() || `Command failed: ${cmd.join(" ")}`);
  }

  return stdout;
}

function basename(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function stripPrefixes(path: string) {
  return path.replace(/^[ab]\//, "");
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

function countDiffStats(metadata: FileDiffMetadata) {
  let additions = 0;
  let deletions = 0;

  for (const hunk of metadata.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "change") {
        additions += content.additions;
        deletions += content.deletions;
      }
    }
  }

  return { additions, deletions };
}

function findPatchChunk(metadata: FileDiffMetadata, chunks: string[], index: number) {
  const byIndex = chunks[index];
  if (byIndex) {
    return byIndex;
  }

  return (
    chunks.find((chunk) =>
      [metadata.name, metadata.prevName]
        .filter((value): value is string => Boolean(value))
        .some((path) => chunk.includes(`a/${path}`) || chunk.includes(`b/${path}`) || chunk.includes(path)),
    ) ?? ""
  );
}

function buildDiffFile(
  metadata: FileDiffMetadata,
  patch: string,
  index: number,
  sourcePrefix: string,
  agentContext: AgentContext | null,
  previousPath?: string,
): DiffFile {
  return {
    id: `${sourcePrefix}:${index}:${metadata.name}`,
    path: metadata.name,
    previousPath: previousPath ?? metadata.prevName,
    patch,
    language: getFiletypeFromFileName(metadata.name) ?? undefined,
    stats: countDiffStats(metadata),
    metadata,
    agent: findAgentFileContext(agentContext, metadata.name, metadata.prevName),
  };
}

function normalizePatchChangeset(
  patchText: string,
  title: string,
  sourceLabel: string,
  agentContext: AgentContext | null,
): Changeset {
  const parsedPatches = parsePatchFiles(patchText, "patch", true);
  const metadataFiles = parsedPatches.flatMap((entry) => entry.files);
  const chunks = splitPatchIntoFileChunks(patchText);

  return {
    id: `changeset:${Date.now()}`,
    sourceLabel,
    title,
    summary: parsedPatches.map((entry) => entry.patchMetadata).filter(Boolean).join("\n\n") || undefined,
    agentSummary: agentContext?.summary,
    files: metadataFiles.map((metadata, index) =>
      buildDiffFile(metadata, findPatchChunk(metadata, chunks, index), index, sourceLabel, agentContext),
    ),
  };
}

async function loadFileDiffChangeset(input: FileCommandInput | DiffToolCommandInput, agentContext: AgentContext | null) {
  const leftText = await Bun.file(input.left).text();
  const rightText = await Bun.file(input.right).text();
  const displayPath =
    input.kind === "difftool"
      ? input.path ?? basename(input.right)
      : input.left === input.right
        ? basename(input.left)
        : `${basename(input.left)} ↔ ${basename(input.right)}`;

  const oldFile: FileContents = {
    name: displayPath,
    contents: leftText,
    cacheKey: `${input.left}:left`,
  };
  const newFile: FileContents = {
    name: displayPath,
    contents: rightText,
    cacheKey: `${input.right}:right`,
  };

  const metadata = parseDiffFromFile(oldFile, newFile, { context: 3 }, true);
  const patch = createTwoFilesPatch(displayPath, displayPath, leftText, rightText, "", "", {
    context: 3,
  });

  return {
    id: `pair:${displayPath}`,
    sourceLabel: input.kind === "difftool" ? "git difftool" : "file compare",
    title: displayPath,
    agentSummary: agentContext?.summary,
    files: [buildDiffFile(metadata, patch, 0, displayPath, agentContext)],
  } satisfies Changeset;
}

async function loadGitChangeset(input: GitCommandInput, agentContext: AgentContext | null) {
  const repoRoot = spawnText(["git", "rev-parse", "--show-toplevel"]).trim();
  const repoName = basename(repoRoot);
  const args = ["git", "diff", "--no-ext-diff", "--find-renames", "--no-color"];

  if (input.staged) {
    args.push("--staged");
  }

  if (input.range) {
    args.push(input.range);
  }

  const patchText = spawnText(args);
  const title = input.staged ? `${repoName} staged changes` : input.range ? `${repoName} ${input.range}` : `${repoName} working tree`;

  return normalizePatchChangeset(patchText, title, repoRoot, agentContext);
}

async function loadPatchChangeset(input: PatchCommandInput, agentContext: AgentContext | null) {
  const patchText =
    !input.file || input.file === "-"
      ? await new Response(Bun.stdin.stream()).text()
      : await Bun.file(input.file).text();

  const label = input.file && input.file !== "-" ? input.file : "stdin patch";
  return normalizePatchChangeset(patchText, `Patch review: ${basename(label)}`, label, agentContext);
}

export async function loadAppBootstrap(input: CliInput): Promise<AppBootstrap> {
  const agentContext = await loadAgentContext(input.options.agentContext);

  let changeset: Changeset;

  switch (input.kind) {
    case "git":
      changeset = await loadGitChangeset(input, agentContext);
      break;
    case "diff":
      changeset = await loadFileDiffChangeset(input, agentContext);
      break;
    case "patch":
      changeset = await loadPatchChangeset(input, agentContext);
      break;
    case "difftool":
      changeset = await loadFileDiffChangeset(input, agentContext);
      break;
  }

  return {
    input,
    changeset,
    initialMode: input.options.mode,
    initialTheme: input.options.theme,
  };
}
