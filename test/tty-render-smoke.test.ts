import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
const ttyToolsAvailable = Bun.spawnSync(["bash", "-lc", "command -v script >/dev/null && command -v timeout >/dev/null"], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
}).exitCode === 0;

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stripTerminalControl(text: string) {
  return text
    .replace(/^Script started.*?\n/s, "")
    .replace(/\nScript done.*$/s, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

function createFixtureFiles() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-tty-smoke-"));
  tempDirs.push(dir);

  const before = join(dir, "before.ts");
  const after = join(dir, "after.ts");
  const agent = join(dir, "agent.json");

  writeFileSync(before, "export const answer = 41;\n");
  writeFileSync(after, "export const answer = 42;\nexport const added = true;\n");
  writeFileSync(
    agent,
    JSON.stringify({
      version: 1,
      files: [
        {
          path: "after.ts",
          annotations: [{ newRange: [2, 2], summary: "Adds bonus export." }],
        },
      ],
    }),
  );

  return { dir, before, after, agent };
}

async function runTtySmoke(options: { mode?: "split" | "stack"; pager?: boolean; agentContext?: boolean }) {
  const fixture = createFixtureFiles();
  const transcript = join(fixture.dir, "transcript.txt");
  const args = ["diff", fixture.before, fixture.after];

  if (options.mode) {
    args.push("--mode", options.mode);
  }

  if (options.pager) {
    args.push("--pager");
  }

  if (options.agentContext) {
    args.push("--agent-context", fixture.agent);
  }

  const command = `timeout 2 bun run src/main.tsx ${args.map(shellQuote).join(" ")}`;
  const proc = Bun.spawnSync(["script", "-q", "-f", "-e", "-c", command, transcript], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TERM: "xterm-256color",
    },
  });

  if (proc.exitCode !== 0 && proc.exitCode !== 124) {
    const stderr = Buffer.from(proc.stderr).toString("utf8");
    throw new Error(stderr.trim() || `tty smoke command failed with exit ${proc.exitCode}`);
  }

  return stripTerminalControl(await Bun.file(transcript).text());
}

afterEach(() => {
  cleanupTempDirs();
});

describe("TTY render smoke", () => {
  test("split mode renders chrome, rails, and AI badges in a terminal transcript", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const output = await runTtySmoke({ mode: "split", agentContext: true });

    expect(output).toContain("View  Navigate  Theme  Agent  Help");
    expect(output).toContain("before.ts ↔ after.ts");
    expect(output).toContain("[AI]");
    expect(output).toContain("▌@@ -1,1 +1,2 @@");
    expect(output).toContain("▌1 - export const answer = 41;");
    expect(output).toContain("▌1 + export const answer = 42;");
  });

  test("stack mode keeps the terminal-native stacked rows without split separators", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const output = await runTtySmoke({ mode: "stack" });

    expect(output).toContain("View  Navigate  Theme  Agent  Help");
    expect(output).toContain("▌1   -  export const answer = 41;");
    expect(output).toContain("▌  1 +  export const answer = 42;");
    expect(output).not.toContain("│1 + export const answer = 42;");
  });

  test("pager mode hides chrome while still rendering the diff transcript", async () => {
    if (!ttyToolsAvailable) {
      return;
    }

    const output = await runTtySmoke({ pager: true });

    expect(output).not.toContain("View  Navigate  Theme  Agent  Help");
    expect(output).not.toContain("F10 menu");
    expect(output).toContain("before.ts -> after.ts");
    expect(output).toContain("export const answer = 42;");
  });
});
