import { testRender } from "@opentui/react/test-utils";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { loadAppBootstrap } from "../src/core/loaders";
import { AppHost } from "../src/ui/AppHost";

function runGit(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(Buffer.from(proc.stderr).toString("utf8").trim());
  }
}

/** Generate a large untracked file that stays small on disk for manual render checks. */
function createLargeFileBody(lineCount: number) {
  return (
    Array.from({ length: lineCount }, (_, index) => {
      if (index === 0) {
        return "visible-first-line";
      }
      if (index === lineCount - 1) {
        return "the widest generated line";
      }
      return "x";
    }).join("\n") + "\n"
  );
}

const lineCount = Number.parseInt(process.argv[2] ?? "100000", 10);
const fixtureKind = process.argv[3] === "tracked" ? "tracked" : "untracked";
if (!Number.isFinite(lineCount) || lineCount <= 0) {
  throw new Error("Usage: bun run scripts/test-large-untracked-render.tsx [line-count] [tracked]");
}

const repo = mkdtempSync(join(tmpdir(), "hunk-large-untracked-render-"));
try {
  runGit(repo, "init", "--initial-branch", "main");
  runGit(repo, "config", "user.name", "Test User");
  runGit(repo, "config", "user.email", "test@example.com");
  const largePath = fixtureKind === "tracked" ? "large-tracked.txt" : "large-untracked.txt";
  writeFileSync(join(repo, "tracked.txt"), "tracked\n");
  if (fixtureKind === "tracked") {
    writeFileSync(join(repo, largePath), "original\n");
  }
  runGit(repo, "add", ".");
  runGit(repo, "commit", "-m", "initial");
  writeFileSync(join(repo, largePath), createLargeFileBody(lineCount));

  const bootstrap = await loadAppBootstrap(
    { kind: "vcs", staged: false, options: { mode: "stack" } },
    { cwd: repo },
  );
  const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 120, height: 30 });

  try {
    await act(async () => {
      await setup.renderOnce();
    });

    const frame = setup.captureCharFrame();
    console.log(
      JSON.stringify(
        {
          containsHeader: frame.includes(`@@ -0,0 +1,${lineCount} @@`),
          containsPath: frame.includes(largePath),
          containsSkippedLargeMessage: frame.includes("File too large to render"),
          containsVisibleLine: frame.includes("visible-first-line"),
          fileCount: bootstrap.changeset.files.length,
          firstFileStats: bootstrap.changeset.files[0]?.stats,
          firstFileStatsTruncated: bootstrap.changeset.files[0]?.statsTruncated,
          fixtureKind,
          lineCount,
          renderedFrameBytes: Buffer.byteLength(frame),
        },
        null,
        2,
      ),
    );
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
} finally {
  rmSync(repo, { force: true, recursive: true });
}
