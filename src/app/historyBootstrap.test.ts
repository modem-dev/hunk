import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryCommandInput } from "../core/run/commandInputs";
import type { VcsAdapter, VcsCatalog, VcsHistorySource } from "../core/vcs/types";
import { loadHistoryBootstrap } from "./historyBootstrap";

const input: HistoryCommandInput = {
  kind: "history",
  color: "never",
  format: "compact",
  ascii: false,
  static: false,
  vcs: "test",
  extensionsEnabled: false,
  extensionPaths: [],
};

describe("history bootstrap cursor ownership", () => {
  test("cancels refresh before opening and closes each active provider cursor once", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hunk-history-bootstrap-"));
    const configHome = mkdtempSync(join(tmpdir(), "hunk-history-config-"));
    const closeCounts: number[] = [];
    let opens = 0;
    const makeSource = (): VcsHistorySource => {
      const index = opens++;
      closeCounts[index] = 0;
      return {
        async read() {
          return { commits: [], done: true };
        },
        async close() {
          closeCounts[index]! += 1;
        },
      };
    };
    const adapter: VcsAdapter = {
      id: "test",
      name: "Test",
      detect: () => ({ id: "test", repoRoot: cwd }),
      operations: {},
      history: {
        async open() {
          return makeSource();
        },
        async planReview(commit) {
          return { kind: "revision-show", revisionId: commit.revisionId };
        },
      },
    };
    const catalog: VcsCatalog = {
      adapters: [adapter],
      defaultAdapterId: "test",
      reservedIds: new Set(["test"]),
    };

    try {
      const bootstrap = await loadHistoryBootstrap({
        input,
        cwd,
        env: { ...process.env, XDG_CONFIG_HOME: configHome },
        baseVcsCatalog: catalog,
      });
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(bootstrap.reopenSource(cancelled.signal)).rejects.toThrow();
      expect(opens).toBe(1);

      await bootstrap.reopenSource();
      expect(opens).toBe(2);
      expect(closeCounts).toEqual([1, 0]);
      await bootstrap.close();
      await bootstrap.close();
      expect(closeCounts).toEqual([1, 1]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
    }
  });
});
