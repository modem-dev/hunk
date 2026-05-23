import { parseDiffFromFile } from "@pierre/diffs";
import type { FileSourceFetcher, FileSourceSide } from "../../src/core/fileSource";
import type { AgentAnnotation, AgentFileContext, DiffFile } from "../../src/core/types";

function collectChangeStats(metadata: DiffFile["metadata"]) {
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

export function lines(...values: string[]) {
  return `${values.join("\n")}\n`;
}

export function createTestAgentFileContext(
  path: string,
  {
    summary = `${path} note`,
    annotations = [
      {
        newRange: [2, 2],
        summary: `Annotation for ${path}`,
        rationale: `Why ${path} changed`,
      },
    ],
  }: {
    summary?: string;
    annotations?: AgentAnnotation[];
  } = {},
): AgentFileContext {
  return {
    path,
    summary,
    annotations,
  };
}

export function createTestDiffFile({
  after = "const alpha = 10;\nconst beta = 2;\nconst gamma = 30;\nconst stable = true;\n",
  before = "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\nconst stable = true;\n",
  id = "example",
  language = "typescript",
  path = "example.ts",
  previousPath,
  context = 0,
  agent = null,
  sourceFetcher,
}: {
  after?: string;
  before?: string;
  id?: string;
  language?: string;
  path?: string;
  previousPath?: string;
  context?: number;
  agent?: DiffFile["agent"] | boolean;
  sourceFetcher?: FileSourceFetcher;
} = {}): DiffFile {
  const metadata = parseDiffFromFile(
    { cacheKey: `${id}:before`, contents: before, name: path },
    { cacheKey: `${id}:after`, contents: after, name: path },
    { context },
    true,
  );

  return {
    agent: agent === true ? createTestAgentFileContext(path) : agent === false ? null : agent,
    id,
    language,
    metadata,
    patch: "",
    path,
    previousPath,
    sourceFetcher,
    stats: collectChangeStats(metadata),
  };
}

/** Build a promise handle that lets async tests settle work manually. */
export function createTestDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, reject, resolve };
}

/** Build a source fetcher that records every requested side. */
export function createTestSourceFetcher(
  read: (side: FileSourceSide) => string | null | Promise<string | null>,
): FileSourceFetcher & { calls: FileSourceSide[] } {
  const calls: FileSourceSide[] = [];

  return {
    calls,
    async getFullText(side) {
      calls.push(side);
      return read(side);
    },
  };
}

export function createTestHeaderOnlyDiffFile(): DiffFile {
  const file = createTestDiffFile({
    before: "const alpha = 1;\n",
    after: "const alpha = 2;\n",
    id: "header-only",
    path: "header-only.ts",
  });

  return {
    ...file,
    metadata: {
      ...file.metadata,
      isPartial: true,
      hunks: file.metadata.hunks.map((hunk) => ({
        ...hunk,
        additionLines: 0,
        deletionLines: 0,
        hunkContent: [],
      })),
    },
  };
}
