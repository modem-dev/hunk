import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { HistoryCommit } from "../../core/history/types";
import type { HistoryRuntime } from "./types";
import { runStaticHistory } from "./runStaticHistory";

/** Create a page-backed runtime and expose whether cleanup ran. */
function runtime(commits: HistoryCommit[], maxCount?: number) {
  let offset = 0;
  let closed = 0;
  let reads = 0;
  const value: HistoryRuntime = {
    input: {
      kind: "history",
      color: "never",
      format: "medium",
      ascii: false,
      interactive: false,
      extensionsEnabled: true,
      extensionPaths: [],
      ...(maxCount !== undefined ? { maxCount } : {}),
    },
    providerId: "test",
    providerName: "Test",
    repoRoot: "/repo",
    notices: [],
    customThemes: [],
    async planReview(commit) {
      return { kind: "revision-show", revisionId: commit.revisionId };
    },
    async reopenSource() {
      return value.source;
    },
    source: {
      async read({ limit }) {
        reads += 1;
        const page = commits.slice(offset, offset + limit);
        offset += page.length;
        return { commits: page, done: offset >= commits.length };
      },
      async close() {},
    },
    async close() {
      closed += 1;
    },
  };
  return { value, closed: () => closed, reads: () => reads };
}

const commits: HistoryCommit[] = ["a", "b"].map((id, index) => ({
  revisionId: id,
  displayId: id.repeat(8),
  parentRevisionIds: index === 0 ? ["b"] : [],
  subject: `Commit ${id}`,
  authorName: "Ada",
  authoredAt: "2026-01-01T00:00:00Z",
  decorations: [],
}));

describe("static history runner", () => {
  test("writes complete rows directly to non-TTY output and closes", async () => {
    const history = runtime(commits);
    let output = "";
    let paged = "";
    await runStaticHistory(history.value, {
      stdout: {
        isTTY: false,
        columns: 80,
        rows: 24,
        write: (text) => ((output += String(text)), true),
      },
      stderr: { write: () => true },
      env: {},
      pageText: async (text) => {
        paged = text;
      },
    });
    expect(output).toContain("Commit a");
    expect(output).toContain("Commit b");
    expect(paged).toBe("");
    expect(history.closed()).toBe(1);
  });

  test("treats a downstream EPIPE as normal and still closes the source", async () => {
    const history = runtime(commits);
    const stdout = new EventEmitter() as EventEmitter & {
      isTTY: boolean;
      columns: number;
      rows: number;
      write(text: string): boolean;
    };
    stdout.isTTY = false;
    stdout.columns = 80;
    stdout.rows = 24;
    stdout.write = () => {
      queueMicrotask(() =>
        stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })),
      );
      return false;
    };
    await runStaticHistory(history.value, {
      stdout: stdout as never,
      stderr: { write: () => true },
      env: {},
      pageText: async () => {},
    });
    expect(history.closed()).toBe(1);
  });

  test("uses the pager only when TTY rows overflow", async () => {
    const history = runtime(commits);
    let paged = "";
    await runStaticHistory(history.value, {
      stdout: { isTTY: true, columns: 80, rows: 2, write: () => true },
      stderr: { write: () => true },
      env: { TERM: "xterm" },
      pageText: async (text) => {
        paged = text;
      },
    });
    expect(paged).toContain("Commit a");
    expect(paged).toContain("Commit b");
  });

  test("streams overflowing TTY pages through one bounded pager writer", async () => {
    const history = runtime(commits);
    let written = "";
    let closes = 0;
    await runStaticHistory(history.value, {
      stdout: { isTTY: true, columns: 80, rows: 2, write: () => true },
      stderr: { write: () => true },
      env: { TERM: "xterm" },
      pageText: async () => {
        throw new Error("buffered pager should not run");
      },
      openPager: () => ({
        async write(text) {
          written += text;
        },
        async close() {
          closes += 1;
        },
      }),
    });
    expect(written).toContain("Commit a");
    expect(written).toContain("Commit b");
    expect(closes).toBe(1);
  });

  test("stops traversing history when the pager closes early", async () => {
    const manyCommits = Array.from({ length: 600 }, (_, index) => ({
      ...commits[1]!,
      revisionId: `commit-${index}`,
      displayId: `c${index}`,
      subject: `Commit ${index}`,
    }));
    const history = runtime(manyCommits);
    let closes = 0;
    await runStaticHistory(history.value, {
      stdout: { isTTY: true, columns: 80, rows: 2, write: () => true },
      stderr: { write: () => true },
      env: { TERM: "xterm" },
      pageText: async () => {},
      openPager: () => ({
        async write() {
          return false;
        },
        async close() {
          closes += 1;
        },
      }),
    });
    expect(history.reads()).toBe(1);
    expect(history.closed()).toBe(1);
    expect(closes).toBe(1);
  });

  test("keeps max-count zero silent even on a TTY", async () => {
    const history = runtime([], 0);
    let output = "";
    await runStaticHistory(history.value, {
      stdout: {
        isTTY: true,
        columns: 80,
        rows: 24,
        write: (text) => ((output += String(text)), true),
      },
      stderr: { write: () => true },
      env: {},
      pageText: async () => {},
    });
    expect(output).toBe("");
  });
});
