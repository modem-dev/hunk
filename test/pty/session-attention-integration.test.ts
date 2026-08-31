import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness, lineIndexOf, rowCellBackgrounds } from "./harness";

const harness = createPtyHarness();
const repoRoot = process.cwd();

/** Give PTY-backed startup, daemon registration, and redraws headroom on slower CI machines. */
setDefaultTimeout(45_000);

/**
 * One tall hunk with a needle deep inside it: every line differs, so git emits
 * a single hunk whose marked line cannot share a 24-row viewport with its
 * anchor — the shape only a line-exact reveal can land.
 */
const NEEDLE_LINE = 111;
const NEEDLE_TOKEN = "ATTENTIONNEEDLE";
// `export const ` is 13 code units, so "needle" occupies offsets [13, 19).
const NEEDLE_START = 13;
const NEEDLE_END = 19;

const tempDirs: string[] = [];

afterEach(() => {
  harness.cleanup();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Write the tall before/after fixture pair into one tracked temp directory. */
function createTallFilePair() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-session-attention-"));
  tempDirs.push(dir);

  const before = join(dir, "before.ts");
  const after = join(dir, "after.ts");
  writeFileSync(
    before,
    `${Array.from(
      { length: 130 },
      (_, index) => `export const line${String(index + 1).padStart(3, "0")} = ${index + 1};`,
    ).join("\n")}\n`,
  );
  writeFileSync(
    after,
    `${Array.from({ length: 130 }, (_, index) =>
      index + 1 === NEEDLE_LINE
        ? `export const needle = "${NEEDLE_TOKEN}";`
        : `export const line${String(index + 1).padStart(3, "0")} = ${index + 1001};`,
    ).join("\n")}\n`,
  );

  return { dir, before, after };
}

/** Reserve one free loopback port so parallel test files cannot collide on the daemon. */
async function reserveLoopbackPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });

  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));

  if (!port) {
    throw new Error("Failed to reserve a loopback port for the session daemon test.");
  }

  return port;
}

/** Run one `hunk session ...` CLI invocation against the test daemon port. */
function runSessionCli(args: string[], port: number, configHome: string) {
  const proc = Bun.spawnSync(["bun", "run", "src/main.tsx", "session", ...args], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      HUNK_MCP_PORT: String(port),
    },
  });

  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
  };
}

/** Poll one condition until it returns a value or the timeout passes. */
async function waitUntil<T>(
  label: string,
  fn: () => Promise<T | null> | T | null,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await fn();
    if (value !== null) {
      return value;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }

    await Bun.sleep(150);
  }
}

describe("PTY session attention marks", () => {
  test("a session CLI highlight paints the range and reveals the deep line", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = createTallFilePair();
    const port = await reserveLoopbackPort();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "stack"],
      cwd: fixture.dir,
      cols: 140,
      rows: 24,
      env: {
        XDG_CONFIG_HOME: configHome,
        // The harness disables session brokering by default; this test is about it.
        HUNK_MCP_DISABLE: "0",
        HUNK_MCP_PORT: String(port),
      },
    });

    let daemonPid: number | null = null;

    try {
      const review = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line001"),
        30_000,
      );
      // The review opens at the hunk anchor, pages above the marked line.
      expect(review).not.toContain(NEEDLE_TOKEN);

      const health = await waitUntil("session daemon health", async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          return response.ok ? ((await response.json()) as { pid: number }) : null;
        } catch {
          return null;
        }
      });
      daemonPid = health.pid;

      const sessionId = await waitUntil("registered Hunk session", () => {
        const listed = runSessionCli(["list", "--json"], port, configHome);
        if (listed.exitCode !== 0) {
          return null;
        }

        const parsed = JSON.parse(listed.stdout) as { sessions: Array<{ sessionId: string }> };
        return parsed.sessions[0]?.sessionId ?? null;
      });

      // Mark "needle" on the deep line and focus it in one call.
      const highlight = runSessionCli(
        [
          "highlight",
          "add",
          sessionId,
          "--file",
          "after.ts",
          "--new-line",
          String(NEEDLE_LINE),
          "--start",
          String(NEEDLE_START),
          "--end",
          String(NEEDLE_END),
          "--tone",
          "warning",
          "--focus",
          "--json",
        ],
        port,
        configHome,
      );
      expect(highlight.stderr).toBe("");
      expect(highlight.exitCode).toBe(0);
      expect(JSON.parse(highlight.stdout)).toMatchObject({
        result: {
          filePath: "after.ts",
          side: "new",
          line: NEEDLE_LINE,
          start: NEEDLE_START,
          end: NEEDLE_END,
          tone: "warning",
          fileMarkCount: 1,
          revealed: "line",
        },
      });

      // The focus reveal landed the marked line near the viewport top, where
      // every other Hunk reveal lands.
      const revealed = await harness.waitForSnapshot(
        session,
        (text) => text.includes(NEEDLE_TOKEN),
        20_000,
      );
      const row = lineIndexOf(revealed, NEEDLE_TOKEN);
      expect(row).toBeGreaterThan(0);
      expect(row).toBeLessThan(12);

      // The mark paints: cells under "needle" carry a background the same
      // row's unmarked cells do not. Text snapshots cannot show this; the
      // per-cell backgrounds can.
      const rowText = revealed.split("\n")[row]!;
      const markedColumn = rowText.indexOf("needle");
      const unmarkedColumn = rowText.indexOf(NEEDLE_TOKEN);
      expect(markedColumn).toBeGreaterThanOrEqual(0);
      const backgrounds = rowCellBackgrounds(session, row);
      expect(backgrounds[markedColumn]).toBeDefined();
      expect(backgrounds[markedColumn]).not.toBe(backgrounds[unmarkedColumn]);

      // Clearing removes the only mark and reports honest counts.
      const cleared = runSessionCli(["highlight", "clear", sessionId, "--json"], port, configHome);
      expect(cleared.exitCode).toBe(0);
      expect(JSON.parse(cleared.stdout)).toMatchObject({
        result: { removedCount: 1, remainingCount: 0 },
      });

      // Line-target navigation reports the same line-exact landing.
      const navigate = runSessionCli(
        ["navigate", sessionId, "--file", "after.ts", "--new-line", "25", "--json"],
        port,
        configHome,
      );
      expect(navigate.exitCode).toBe(0);
      expect(JSON.parse(navigate.stdout)).toMatchObject({
        result: { filePath: "after.ts", revealed: "line", side: "new", line: 25 },
      });
      const navigated = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line025") && !text.includes(NEEDLE_TOKEN),
        20_000,
      );
      const navigatedRow = lineIndexOf(navigated, "line025");
      expect(navigatedRow).toBeGreaterThan(0);
      expect(navigatedRow).toBeLessThan(12);
    } finally {
      session.close();
      if (daemonPid) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          // Ignore daemons that already exited during cleanup.
        }
      }
    }
  });
});
