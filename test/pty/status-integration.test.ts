import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { writeExtensionTrust, resolveRepoTrust } from "../../packages/hunk/src/extensions/trust";
import { createTestStatusSnapshot } from "../helpers/vcsStatus";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const roots: string[] = [];
setDefaultTimeout(45_000);

/** Run deterministic, shell-free Git fixture commands. */
function runStatusPtyTestGit(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Status",
      GIT_AUTHOR_EMAIL: "status@example.com",
      GIT_COMMITTER_NAME: "Status",
      GIT_COMMITTER_EMAIL: "status@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode) throw new Error(result.stderr.toString());
}
/** Create mixed changes plus a linked sibling without modifying the developer checkout. */
function createStatusPtyTestRepo() {
  const root = mkdtempSync(join(tmpdir(), "hunk-status-pty-"));
  roots.push(root);
  const cwd = join(root, "origin");
  const sibling = join(root, "sibling");
  mkdirSync(cwd);
  runStatusPtyTestGit(cwd, ["init", "-qb", "main"]);
  writeFileSync(join(cwd, "alpha.ts"), "export const statusAlpha = 1;\n");
  writeFileSync(join(cwd, "beta.ts"), "export const statusBeta = 1;\n");
  runStatusPtyTestGit(cwd, ["add", "."]);
  runStatusPtyTestGit(cwd, ["commit", "-qm", "Status initial commit"]);
  runStatusPtyTestGit(cwd, ["worktree", "add", "-qb", "sibling-branch", sibling]);
  writeFileSync(join(cwd, "alpha.ts"), "export const statusAlpha = 2;\n");
  runStatusPtyTestGit(cwd, ["add", "alpha.ts"]);
  writeFileSync(join(cwd, "alpha.ts"), "export const statusAlpha = 3;\n");
  writeFileSync(join(cwd, "beta.ts"), "export const statusBeta = 2;\n");
  return { cwd, sibling };
}
afterEach(() => {
  harness.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("status reuses real multi-file diff and log routes, with mouse actions and terminal cleanup", async () => {
  const { cwd } = createStatusPtyTestRepo();
  const session = await harness.launchHunk({
    cwd,
    args: ["status", "--no-extensions", "--color", "never"],
    cols: 120,
    rows: 24,
  });
  try {
    const status = await session.waitForText(/sibling-branch/, { timeout: 15_000 });
    expect(status).toContain("alpha.ts  modified (staged) · modified (unstaged)");
    expect(status).toContain("beta.ts  modified (unstaged)");
    expect(status).toContain("Tracked changes (2)");
    expect(status).toContain("Untracked files (0)");
    expect(status).not.toContain("Index / worktree");
    const strip = status.split("\n").find((line) => line.includes("Working tree changes"))!;
    expect(strip).not.toMatch(/Log|Quit/);
    const boundary = status.split("\n").findIndex((line) => line.includes("── Other worktrees ──"));
    expect(boundary).toBeGreaterThan(0);
    expect(status.split("\n")[boundary - 1]!.trim()).toBe("");
    expect(status).not.toContain("Selected file");
    // The ordinary action row exposes the same full-comparison action as U.
    // Tuistory includes pre-alternate-screen scrollback; mouse coordinates are screen-relative.
    const screenLines = status.split("\n").slice(-24);
    const actionRow = screenLines.findIndex((line) => line.includes("Working tree changes"));
    const actionColumn = screenLines[actionRow]!.indexOf("Working tree changes");
    session.writeRaw(
      `\x1b[<0;${actionColumn + 2};${actionRow + 1}M\x1b[<0;${actionColumn + 2};${actionRow + 1}m`,
    );
    const review = await session.waitForText(/statusBeta = 2/, { timeout: 15_000 });
    expect(review).toContain("statusAlpha = 3");
    await session.press("q");
    await session.waitForText(/Other worktrees/, { timeout: 15_000 });
    await session.press("l");
    await session.waitForText(/Status initial commit/, { timeout: 15_000 });
    await session.press("enter");
    await session.waitForText(/statusAlpha = 1/, { timeout: 15_000 });
    await session.press("q");
    await session.waitForText(/Status initial commit/, { timeout: 15_000 });
    await session.press("q");
    await session.waitForText(/Other worktrees/, { timeout: 15_000 });
    await session.press("q");
    await harness.waitForSnapshot(
      session,
      () => session.getRawOutput().includes("\x1b[?1049l"),
      5000,
    );
    expect(session.getRawOutput()).toContain("\x1b[?1049l");
  } finally {
    session.close();
  }
});

test("narrow/short resize, edit refresh and sibling inspect/back preserve the single status view", async () => {
  const { cwd, sibling } = createStatusPtyTestRepo();
  const session = await harness.launchHunk({
    cwd,
    args: ["status", "--no-extensions", "--color", "never"],
    cols: 100,
    rows: 24,
  });
  try {
    await session.waitForText(/sibling-branch/, { timeout: 15_000 });
    await session.press("down");
    writeFileSync(join(cwd, "aaa-new.ts"), "export const newStatusFile = true;\n");
    await session.waitForText(/3 changed paths/, { timeout: 15_000 });
    session.resize({ cols: 42, rows: 10 });
    const narrow = await session.waitForText(/beta.ts/, { timeout: 5000 });
    expect(narrow).toContain("Other worktrees:");
    expect(narrow).not.toContain("Selected file");
    session.resize({ cols: 120, rows: 24 });
    await session.waitForText(/sibling-branch/, { timeout: 5000 });
    // A new path appends after surviving paths, so beta remains focused after refresh.
    await session.press("down");
    await session.press("down");
    await session.press("enter");
    await session.waitForText(/Clean working tree/, { timeout: 15_000 });
    const inspected = await session.text({ immediate: true });
    expect(inspected).toContain(sibling);
    await session.press("q");
    await session.waitForText(/3 changed paths/, { timeout: 15_000 });
    session.writeRaw("\x03");
    await harness.waitForSnapshot(
      session,
      () => session.getRawOutput().includes("\x1b[?1049l"),
      5000,
    );
  } finally {
    session.close();
  }
});

test("launch custom themes survive sibling manual/watch reloads and reopening through log", async () => {
  const { cwd, sibling } = createStatusPtyTestRepo();
  mkdirSync(join(cwd, ".hunk"));
  mkdirSync(join(sibling, ".hunk"));
  writeFileSync(join(cwd, ".git", "info", "exclude"), ".hunk/\n");
  writeFileSync(
    join(cwd, ".hunk", "config.toml"),
    'theme = "launch-custom"\nwatch = true\nprompt_save_view_preferences = false\n\n[themes.launch-custom]\nlabel = "Launch custom"\naccent = "#123456"\n',
  );
  writeFileSync(join(sibling, ".hunk", "config.toml"), 'theme = "nord"\n');
  writeFileSync(join(sibling, "alpha.ts"), "export const statusAlpha = 8;\n");
  const session = await harness.launchHunk({
    cwd,
    args: ["status", "--no-extensions"],
    cols: 120,
    rows: 24,
  });
  try {
    await session.waitForText(/sibling-branch/, { timeout: 15_000 });
    await session.press("down");
    await session.press("down");
    await session.press("enter");
    await session.waitForText(/1 changed path/, { timeout: 15_000 });
    await session.press("u");
    await session.waitForText(/statusAlpha = 8/, { timeout: 15_000 });
    await session.press("r");
    await session.waitIdle();
    writeFileSync(join(sibling, "alpha.ts"), "export const statusAlpha = 9;\n");
    await session.waitForText(/statusAlpha = 9/, { timeout: 15_000 });
    await session.press("t");
    await session.waitForText(/›\s+Launch custom/, { timeout: 5000 });
    await session.press("escape");
    await session.press("q");
    await session.waitForText(/Other worktrees/, { timeout: 15_000 });
    await session.press("t");
    await session.waitForText(/›\s+Launch custom/, { timeout: 5000 });
    await session.press("escape");
    await session.press("l");
    await session.waitForText(/Status initial commit/, { timeout: 15_000 });
    await session.press("enter");
    await session.waitForText(/statusAlpha = 1/, { timeout: 15_000 });
    await session.press("t");
    await session.waitForText(/›\s+Launch custom/, { timeout: 5000 });
    await session.press("down");
    await session.press("enter");
    await session.press("q");
    await session.waitForText(/Status initial commit/, { timeout: 15_000 });
    await session.press("q");
    await session.waitForText(/Other worktrees/, { timeout: 15_000 });
    await session.press("t");
    await session.waitForText(/›\s+andromeeda/, { timeout: 5000 });
    session.writeRaw("\x03");
    await harness.waitForSnapshot(
      session,
      () => session.getRawOutput().includes("\x1b[?1049l"),
      5000,
    );
  } finally {
    session.close();
  }
});

test("explicit untracked rows remain in the full comparison after refresh without changing aggregate exclusion", async () => {
  const { cwd } = createStatusPtyTestRepo();
  mkdirSync(join(cwd, ".hunk"));
  writeFileSync(join(cwd, ".git", "info", "exclude"), ".hunk/\n");
  writeFileSync(join(cwd, ".hunk", "config.toml"), "exclude_untracked = true\n");
  writeFileSync(join(cwd, "zzz-status.ts"), "export const explicitUntracked = true;\n");
  const session = await harness.launchHunk({
    cwd,
    args: ["status", "--no-extensions", "--color", "never"],
    cols: 120,
    rows: 24,
  });
  try {
    await session.waitForText(/zzz-status.ts/, { timeout: 15_000 });
    await session.press("down");
    await session.press("down");
    await session.press("enter");
    await session.waitForText(/explicitUntracked = true/, { timeout: 15_000 });
    await session.press("r");
    await session.waitIdle();
    expect(await session.text({ immediate: true })).toContain("explicitUntracked = true");
    await session.press("q");
    await session.waitForText(/Other worktrees/, { timeout: 15_000 });
    await session.press("u");
    await session.waitForText(/statusAlpha = 3/, { timeout: 15_000 });
    expect(await session.text({ immediate: true })).not.toContain("zzz-status.ts");
    session.writeRaw("\x03");
    await harness.waitForSnapshot(
      session,
      () => session.getRawOutput().includes("\x1b[?1049l"),
      5000,
    );
  } finally {
    session.close();
  }
});

test("oversized wrapped paths remain keyboard/mouse reachable after narrow and short resize", async () => {
  const { cwd } = createStatusPtyTestRepo();
  const path = join("z".repeat(85), "y".repeat(85), "x".repeat(85), "status-tail.ts");
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), "export const tallStatusTarget = true;\n");
  const session = await harness.launchHunk({
    cwd,
    args: ["status", "--no-extensions"],
    cols: 30,
    rows: 10,
  });
  try {
    await session.waitForText(/alpha.ts/, { timeout: 15_000 });
    await session.press("down");
    await session.press("down");
    for (let i = 0; i < 12; i++) {
      if (
        (await session.text({ immediate: true }))
          .split("\n")
          .slice(-10)
          .map((line) => line.trim())
          .join("")
          .includes("status-tail.ts")
      )
        break;
      await session.press("down");
    }
    expect(
      (await session.text({ immediate: true }))
        .split("\n")
        .slice(-10)
        .map((line) => line.trim())
        .join(""),
    ).toContain("status-tail.ts");
    session.resize({ cols: 34, rows: 11 });
    await session.waitIdle();
    for (let i = 0; i < 4; i++) {
      if (
        (await session.text({ immediate: true }))
          .split("\n")
          .slice(-11)
          .map((line) => line.trim())
          .join("")
          .includes("zzzzzz")
      )
        break;
      session.writeRaw("\x1b[<64;5;6M");
      await session.waitIdle();
    }
    expect(
      (await session.text({ immediate: true }))
        .split("\n")
        .slice(-11)
        .map((line) => line.trim())
        .join(""),
    ).toContain("zzzzzz");
    for (let i = 0; i < 4; i++) {
      if (
        (await session.text({ immediate: true }))
          .split("\n")
          .slice(-11)
          .map((line) => line.trim())
          .join("")
          .includes("status-tail.ts")
      )
        break;
      session.writeRaw("\x1b[<65;5;6M");
      await session.waitIdle();
    }
    expect(
      (await session.text({ immediate: true }))
        .split("\n")
        .slice(-11)
        .map((line) => line.trim())
        .join(""),
    ).toContain("status-tail.ts");
    // Enter still opens the long path's full comparison, not the next row below it.
    session.resize({ cols: 120, rows: 24 });
    await session.waitIdle();
    await session.press("enter");
    await session.waitForText(/tallStatusTarget = true/, { timeout: 15_000 });
  } finally {
    session.close();
  }
});

/** Poll externally observable lifecycle facts without relying on fixed startup sleeps. */
async function waitStatusPtyTestFact<T>(read: () => T | undefined | Promise<T | undefined>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting for status lifecycle fact");
}

/** Allocate a private loopback broker endpoint for this terminal integration. */
async function reserveStatusPtyTestPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test("enabled trusted launch extensions span real broker-mounted sibling reviews and shut down once", async () => {
  const { cwd, sibling } = createStatusPtyTestRepo();
  const configHome = harness.createIsolatedConfigHome();
  const events = join(dirname(cwd), "extension-events.log");
  const forbidden = join(dirname(cwd), "sibling-extension-ran");
  mkdirSync(join(cwd, ".hunk", "extensions"), { recursive: true });
  mkdirSync(join(sibling, ".hunk", "extensions"), { recursive: true });
  writeFileSync(join(cwd, ".git", "info", "exclude"), ".hunk/\n");
  writeFileSync(
    join(cwd, ".hunk", "extensions", "owned.ts"),
    `
    import { appendFileSync } from "node:fs";
    export default function(hunk) {
      appendFileSync(${JSON.stringify(events)}, "factory\\n");
      hunk.on("startup", () => appendFileSync(${JSON.stringify(events)}, "startup\\n"));
      hunk.on("shutdown", () => appendFileSync(${JSON.stringify(events)}, "shutdown\\n"));
    }
  `,
  );
  writeFileSync(
    join(sibling, ".hunk", "extensions", "forbidden.ts"),
    `import { writeFileSync } from "node:fs"; export default () => writeFileSync(${JSON.stringify(forbidden)}, "ran");`,
  );
  const env = { ...process.env, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: configHome };
  writeExtensionTrust(cwd, "trusted", { env });
  expect(resolveRepoTrust(sibling, { env })).toBe("unknown");
  writeFileSync(join(sibling, "alpha.ts"), "export const siblingBrokerTarget = 42;\n");
  const port = await reserveStatusPtyTestPort();
  const session = await harness.launchHunk({
    cwd,
    args: ["status", "--vcs", "git"],
    cols: 120,
    rows: 24,
    env: {
      XDG_CONFIG_HOME: configHome,
      XDG_RUNTIME_DIR: configHome,
      HUNK_MCP_DISABLE: "0",
      HUNK_MCP_PORT: String(port),
    },
  });
  let daemonPid: number | undefined;
  const cli = (args: string[]) => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "run",
        resolve(import.meta.dir, "../../packages/hunk/src/main.tsx"),
        "session",
        ...args,
      ],
      {
        env: { ...env, HUNK_MCP_PORT: String(port) },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return JSON.parse(result.stdout.toString());
  };
  try {
    await session.waitForText(/sibling-branch/, { timeout: 15_000 });
    expect(readFileSync(events, "utf8")).toBe("factory\nstartup\n");
    await session.press("down");
    await session.press("down");
    await session.press("enter");
    await session.waitForText(/1 changed path/, { timeout: 15_000 });
    await session.press("u");
    await session.waitForText(/siblingBrokerTarget = 42/, { timeout: 15_000 });
    await waitStatusPtyTestFact(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    });
    // Public health deliberately contains no PID; only this isolated launch record owns teardown.
    daemonPid = JSON.parse(
      readFileSync(join(configHome, "hunk-mcp", `daemon-127-0-0-1-${port}.json`), "utf8"),
    ).pid;
    const mounted = await waitStatusPtyTestFact(() => cli(["list", "--json"]).sessions[0]);
    expect(mounted.cwd).toBe(sibling);
    expect(mounted.repoRoot).toBe(sibling);
    const navigated = cli([
      "navigate",
      mounted.sessionId,
      "--file",
      "alpha.ts",
      "--new-line",
      "1",
      "--json",
    ]);
    expect(navigated.result).toMatchObject({
      filePath: "alpha.ts",
      revealed: "line",
      side: "new",
      line: 1,
    });
    await session.press("q");
    await session.waitForText(/Other worktrees/, { timeout: 15_000 });
    await waitStatusPtyTestFact(() =>
      cli(["list", "--json"]).sessions.length === 0 ? true : undefined,
    );
    await session.press("l");
    await session.waitForText(/Status initial commit/, { timeout: 15_000 });
    expect(cli(["list", "--json"]).sessions).toHaveLength(0);
    await session.press("enter");
    await session.waitForText(/statusAlpha = 1/, { timeout: 15_000 });
    const reopened = await waitStatusPtyTestFact(() => cli(["list", "--json"]).sessions[0]);
    expect(reopened.cwd).toBe(sibling);
    expect(reopened.sessionId).not.toBe(mounted.sessionId);
    expect(readFileSync(events, "utf8")).toBe("factory\nstartup\n");
    expect(existsSync(forbidden)).toBe(false);
    expect(resolveRepoTrust(sibling, { env })).toBe("unknown");
    session.writeRaw("\x03");
    await waitStatusPtyTestFact(() =>
      readFileSync(events, "utf8").includes("shutdown") ? true : undefined,
    );
    await harness.waitForSnapshot(
      session,
      () => session.getRawOutput().includes("\x1b[?1049l"),
      5000,
    );
    expect(readFileSync(events, "utf8")).toBe("factory\nstartup\nshutdown\n");
    await waitStatusPtyTestFact(() =>
      cli(["list", "--json"]).sessions.length === 0 ? true : undefined,
    );
  } finally {
    session.close();
    if (daemonPid) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {}
    }
  }
});

test("unavailable/error sibling rows stay disabled and pending Log preparation cancels locally and globally", async () => {
  const { cwd } = createStatusPtyTestRepo();
  const extension = join(dirname(cwd), "status-provider.ts");
  const events = join(dirname(cwd), "pending-events.log");
  const snapshot = createTestStatusSnapshot(cwd);
  const siblings = {
    truncated: false,
    worktrees: ["unavailable", "error"].map((state, index) => ({
      worktree: {
        ...snapshot.worktree,
        id: `failed-${index}`,
        path: join(dirname(cwd), `failed-${index}`),
      },
      branch: `failed-${index}`,
      detached: false,
      bare: false,
      inspectable: false,
      status: {
        state,
        message: state === "unavailable" ? "Missing worktree" : "Cannot read worktree",
      },
    })),
  };
  writeFileSync(
    extension,
    `
    import { appendFileSync } from "node:fs";
    export default function(hunk) {
      const record = (text) => appendFileSync(${JSON.stringify(events)}, text + "\\n");
      hunk.registerVcsAdapter({ id: "status-test", name: "Status test", detect: () => null,
        status: {
          read: async () => (${JSON.stringify(snapshot)}),
          readSiblings: async () => (${JSON.stringify(siblings)}),
          planReview: async () => { throw new Error("No review"); },
        },
        history: {
          open: async () => ({
            read: ({signal}) => { record("read"); return new Promise(resolve => signal.addEventListener("abort", () => { record("aborted"); resolve({commits: [], done: true}); }, {once: true})); },
            close: async () => { record("close"); throw new Error("Fixture cleanup rejected"); },
          }),
          planReview: () => ({kind: "revision-show", revisionId: "unused"}),
        },
      });
    }
  `,
  );
  const session = await harness.launchHunk({
    cwd,
    args: ["status", "--vcs", "status-test", "--extension", extension],
    cols: 120,
    rows: 24,
  });
  try {
    const ready = await session.waitForText(/Cannot read worktree/, { timeout: 15_000 });
    expect(ready).toContain("unavailable: Missing worktree");
    expect(ready).toContain("error: Cannot read worktree");
    await session.press("down");
    await session.press("enter");
    await session.waitIdle();
    expect(await session.text({ immediate: true })).toContain("Cannot read worktree");
    await session.press("l");
    await session.waitForText(/Preparing…/, { timeout: 5000 });
    await waitStatusPtyTestFact(() => (existsSync(events) ? true : undefined));
    await session.press("q");
    await session.waitForText(/Fixture cleanup rejected/, { timeout: 5000 });
    expect(readFileSync(events, "utf8")).toBe("read\naborted\nclose\n");
    await session.press("l");
    await session.waitForText(/Preparing…/, { timeout: 5000 });
    await waitStatusPtyTestFact(() =>
      readFileSync(events, "utf8").split("read\n").length === 3 ? true : undefined,
    );
    session.writeRaw("\x03");
    await harness.waitForSnapshot(
      session,
      () => session.getRawOutput().includes("\x1b[?1049l"),
      5000,
    );
    expect(readFileSync(events, "utf8")).toBe("read\naborted\nclose\nread\naborted\nclose\n");
  } finally {
    session.close();
  }
});

for (const color of ["always", "never"] as const) {
  test(`live status spans honor custom staging colors and remain legible with color ${color}`, async () => {
    const { cwd } = createStatusPtyTestRepo();
    mkdirSync(join(cwd, ".hunk"));
    writeFileSync(join(cwd, ".git", "info", "exclude"), ".hunk/\n");
    writeFileSync(
      join(cwd, ".hunk", "config.toml"),
      `theme = "status-signs"
prompt_save_view_preferences = false
[themes.status-signs]
base = "nord"
addedSignColor = "#123456"
removedSignColor = "#654321"
accent = "#abcdef"
text = "#eeeeee"
muted = "#aaaaaa"
`,
    );
    writeFileSync(join(cwd, "staged.ts"), "export const staged = true;\n");
    runStatusPtyTestGit(cwd, ["add", "staged.ts"]);
    writeFileSync(join(cwd, "untracked.ts"), "export const untracked = true;\n");
    const hash = Bun.spawnSync(["git", "rev-parse", "HEAD:alpha.ts"], { cwd, stdout: "pipe" })
      .stdout.toString()
      .trim();
    const unmerged = Bun.spawnSync(["git", "update-index", "--index-info"], {
      cwd,
      stdin: Buffer.from(
        [1, 2, 3].map((stage) => `100644 ${hash} ${stage}\tconflict.ts\n`).join(""),
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(unmerged.exitCode).toBe(0);
    const session = await harness.launchHunk({
      cwd,
      args: ["status", "--no-extensions", "--color", color],
      cols: 120,
      rows: 24,
    });
    try {
      const ready = await session.waitForText(/sibling-branch/, { timeout: 15_000 });
      for (const line of [
        "alpha.ts  modified (staged) · modified (unstaged)",
        "beta.ts  modified (unstaged)",
        "staged.ts  new file (staged)",
        "untracked.ts",
        "conflict.ts  unmerged (staged) · unmerged (unstaged) · conflict",
      ])
        expect(ready).toContain(line);
      /** Expand ASCII fixture rows to verify each label and filename cell's actual paint. */
      const cellsFor = (name: string) => {
        const row = session.getTerminalData().lines.find((line) =>
          line.spans
            .map((span) => span.text)
            .join("")
            .includes(name),
        );
        expect(row).toBeDefined();
        return row!.spans.flatMap((span) => [...span.text].map((text) => ({ text, fg: span.fg })));
      };
      const expected = (value: string) => (color === "always" ? value : "#ffffff");
      const mixed = cellsFor("alpha.ts");
      const mixedText = mixed.map((cell) => cell.text).join("");
      expect(mixed[mixedText.indexOf("modified (staged)")]!.fg).toBe(expected("#123456"));
      expect(mixed[mixedText.indexOf("modified (unstaged)")]!.fg).toBe(expected("#654321"));
      expect(mixed[mixedText.indexOf("alpha.ts")]!.fg).toBe(expected("#eeeeee"));
      for (const [name, label, foreground] of [
        ["beta.ts", "modified (unstaged)", "#654321"],
        ["staged.ts", "new file (staged)", "#123456"],
        ["untracked.ts", "untracked.ts", "#654321"],
        ["conflict.ts", "unmerged (staged)", "#abcdef"],
      ]) {
        const cells = cellsFor(name!);
        const text = cells.map((cell) => cell.text).join("");
        expect(cells[text.indexOf(name!)]!.fg).toBe(expected(foreground!));
        expect(cells[text.indexOf(label!)]!.fg).toBe(expected(foreground!));
      }
      const sibling = cellsFor("sibling-branch");
      const siblingText = sibling.map((cell) => cell.text).join("");
      expect(sibling[siblingText.indexOf("sibling-branch")]!.fg).toBe(expected("#abcdef"));
      expect(sibling[siblingText.indexOf(dirname(cwd))]!.fg).toBe(expected("#aaaaaa"));
      session.resize({ cols: 42, rows: 12 });
      await session.waitIdle();
      // Scroll to the last path; the section boundary is in-flow, not a fixed header/inspector.
      for (let i = 0; i < 4; i++) await session.press("down");
      const narrow = (await session.text({ immediate: true })).split("\n").slice(-12).join("\n");
      expect(narrow).toContain("untracked.ts");
      await session.press("down");
      const siblingView = (await session.text({ immediate: true }))
        .split("\n")
        .slice(-12)
        .join("\n");
      expect(siblingView).toContain("── Other worktrees ──");
      expect(siblingView).toContain("sibling-branch");
      expect(siblingView).not.toContain("Selected file");
    } finally {
      session.close();
    }
  });
}

test("bounded file groups expand independently by keyboard and mouse, retain routes, and keep worktrees reachable", async () => {
  const { cwd } = createStatusPtyTestRepo();
  for (let i = 0; i < 9; i++)
    writeFileSync(join(cwd, `tracked-${i}.ts`), `export const added${i} = true;\n`);
  runStatusPtyTestGit(cwd, ["add", ...Array.from({ length: 9 }, (_, i) => `tracked-${i}.ts`)]);
  for (let i = 0; i < 11; i++)
    writeFileSync(
      join(cwd, `new-${String(i).padStart(2, "0")}.ts`),
      "export const newFile = true;\n",
    );
  const session = await harness.launchHunk({
    cwd,
    args: ["status", "--no-extensions", "--color", "never"],
    cols: 42,
    rows: 40,
  });
  const screen = async () =>
    (await session.text({ immediate: true })).split("\n").slice(-40).join("\n");
  const click = async (needle: string, occurrence = 0) => {
    const lines = (await screen()).split("\n");
    const y = lines.map((line, i) => (line.includes(needle) ? i : -1)).filter((i) => i >= 0)[
      occurrence
    ]!;
    expect(y).toBeDefined();
    const x = lines[y]!.indexOf(needle);
    session.writeRaw(`\x1b[<0;${x + 2};${y + 1}M\x1b[<0;${x + 2};${y + 1}m`);
    await session.waitIdle();
  };
  try {
    await session.waitForText(/sibling-branch/, { timeout: 15_000 });
    const collapsed = await screen();
    expect(collapsed).toContain("Tracked changes (11)");
    expect(collapsed).toContain("Untracked files (11)");
    expect(collapsed.match(/and 1 more file/g)).toHaveLength(2);
    expect(collapsed).not.toContain("tracked-8.ts");
    expect(collapsed).not.toContain("new-10.ts");
    expect(collapsed).toContain("── Other worktrees ──");
    expect(collapsed).not.toMatch(/Log|Quit|Index \/ worktree|MM  |\.M  /);
    for (let i = 0; i < 10; i++) await session.press("down");
    await session.press("enter");
    expect(await screen()).toContain("tracked-8.ts");
    expect(await screen()).toContain("Show fewer");
    expect(await screen()).not.toContain("new-10.ts");
    await click("and 1 more file");
    expect(await screen()).toContain("new-10.ts");
    // Mouse expansion must leave keyboard focus on the tracked group's action.
    await session.press("space");
    expect(await screen()).not.toContain("tracked-8.ts");
    expect(await screen()).toContain("new-10.ts");
    await session.press("r");
    await session.waitIdle();
    await session.press("l");
    await session.waitForText(/Status initial commit/, { timeout: 15_000 });
    await session.press("q");
    await session.waitForText(/sibling-branch/, { timeout: 15_000 });
    expect(await screen()).not.toContain("tracked-8.ts");
    expect(await screen()).toContain("new-10.ts");
    await click("sibling-branch");
    await click("sibling-branch");
    await session.waitForText(/Clean working tree/, { timeout: 15_000 });
    expect(await screen()).toContain("Back");
    await session.press("q");
    await session.waitForText(/new-10.ts/, { timeout: 15_000 });
    expect(await screen()).not.toContain("tracked-8.ts");
    session.resize({ cols: 32, rows: 14 });
    await session.waitIdle();
    await session.press("up");
    await session.press("space");
    const narrow = (await session.text({ immediate: true })).split("\n").slice(-14).join("\n");
    expect(narrow).toContain("and 1 more file");
    expect(narrow).not.toContain("new-10.ts");
    await session.press("down");
    expect((await session.text({ immediate: true })).split("\n").slice(-14).join("\n")).toContain(
      "sibling-branch",
    );
  } finally {
    session.close();
  }
});
