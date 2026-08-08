// Drives real Hunk sessions in a headless PTY and captures styled keyframes
// as PNGs for the beta launch video. Run from the repo root with Bun:
//
//   bun run scripts/launch-video/capture.ts [outDir]
//
// Output: <outDir>/frames/*.png. manifest.json is a capture-side inventory of
// this run only — compose.mjs resolves frames by name from its SHOTS table and
// ignores it, and after a SCENES= run the manifest is partial while frames/
// stays cumulative.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchTerminal, type Session } from "tuistory";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// ghostty-opentui is a transitive dependency (via tuistory), so resolve its
// image renderer relative to tuistory's own module graph.
const ghosttyImagePath = Bun.resolveSync(
  "ghostty-opentui/image",
  dirname(Bun.resolveSync("tuistory", repoRoot)),
);
const { renderTerminalToImage } = (await import(ghosttyImagePath)) as {
  renderTerminalToImage: (data: unknown, options?: Record<string, unknown>) => Promise<Buffer>;
};

const outDir = resolve(process.argv[2] ?? join(repoRoot, ".video-work"));
const framesDir = join(outDir, "frames");
mkdirSync(framesDir, { recursive: true });

// One shared terminal geometry so every scene composes into the same window.
const COLS = 140;
const ROWS = 32;
const RENDER_OPTIONS = { fontSize: 16, lineHeight: 1.5, devicePixelRatio: 2 };

interface KeyframeEntry {
  name: string;
  file: string;
  cols: number;
  rows: number;
}
const manifest: KeyframeEntry[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Render the current PTY screen to a named PNG keyframe. */
async function snap(session: Session, name: string) {
  const data = session.getTerminalData();
  const png = await renderTerminalToImage(data, RENDER_OPTIONS);
  const file = `${name}.png`;
  writeFileSync(join(framesDir, file), png);
  manifest.push({ name, file, cols: COLS, rows: ROWS });
  console.log(`  snap ${name}`);
}

const tempDirs: string[] = [];
function makeTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// Isolated config home so captures always show built-in defaults.
const configHome = makeTempDir("hunk-video-config-");

function runGit(args: string[], cwd: string) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (proc.status !== 0) {
    throw new Error(proc.stderr.trim() || `git ${args.join(" ")} failed`);
  }
}

async function launchHunk(args: string[], options: { cwd?: string } = {}) {
  return launchTerminal({
    command: process.execPath,
    args: ["run", join(repoRoot, "src/main.tsx"), "--", ...args],
    cwd: options.cwd ?? repoRoot,
    cols: COLS,
    rows: ROWS,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      HUNK_MCP_DISABLE: "1",
      HUNK_DISABLE_UPDATE_NOTICE: "1",
    },
  });
}

/** Prove the app is accepting keys before scripted presses (startup race). */
async function ensureKeyboardIsLive(session: Session) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await session.press("?");
    try {
      await session.waitForText(/Controls help/, { timeout: 2_000 });
      await session.press("escape");
      await sleep(300);
      return;
    } catch {
      // Key dropped before the handler was bound; retry.
    }
  }
  throw new Error("App never reacted to a keypress.");
}

// ---------------------------------------------------------------------------
// Scene: STML agent notes inside a review (examples/9-agent-markup-notes).
// ---------------------------------------------------------------------------
async function captureStmlScene() {
  console.log("scene: stml");
  const session = await launchHunk([
    "patch",
    join(repoRoot, "examples/9-agent-markup-notes/change.patch"),
    "--agent-context",
    join(repoRoot, "examples/9-agent-markup-notes/agent-context.json"),
    "--experimental",
    "--mode",
    "stack",
  ]);
  try {
    await session.waitForText(/retry\.ts/, { timeout: 60_000 });
    await ensureKeyboardIsLive(session);
    await sleep(500);
    await snap(session, "stml-review");

    await session.press("a");
    await sleep(900);
    await snap(session, "stml-notes");

    // Step down the stream so the second (code-block) note fills the screen.
    for (let step = 0; step < 10; step += 1) {
      await session.press("down");
      await sleep(60);
      if (step === 4 || step === 9) {
        await snap(session, `stml-scroll-${step}`);
      }
    }
    await sleep(400);
    await snap(session, "stml-note-2");
  } finally {
    session.close();
  }
}

/** Write a `hunk` wrapper onto PATH so shell scenes read like the real CLI. */
function createHunkPathWrapper(dir: string) {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, "hunk");
  writeFileSync(
    wrapper,
    `#!/bin/bash\nexec "${process.execPath}" run "${join(repoRoot, "src/main.tsx")}" -- "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return binDir;
}

/** Launch an interactive bash in the PTY with `hunk` on PATH and a clean prompt. */
async function launchShell(cwd: string, binDir: string) {
  return launchTerminal({
    command: "/bin/bash",
    args: ["--noprofile", "--norc", "-i"],
    cwd,
    cols: COLS,
    rows: ROWS,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      XDG_CONFIG_HOME: configHome,
      HUNK_MCP_DISABLE: "1",
      HUNK_DISABLE_UPDATE_NOTICE: "1",
      PS1: "\\[\\e[38;5;213m\\]❯\\[\\e[0m\\] ",
      TERM: "xterm-256color",
    },
  });
}

/** Type a shell command character by character, snapping the requested frames. */
async function typeCommand(session: Session, command: string, snapAt: Record<number, string>) {
  let index = 0;
  for (const char of command) {
    session.writeRaw(char);
    await sleep(30);
    const name = snapAt[index];
    if (name) {
      await snap(session, name);
    }
    index += 1;
  }
}

/**
 * Build a real git repo from the mini-app refactor example: commit the
 * "before" tree, overlay the "after" tree as the working diff.
 */
function createDemoRepo() {
  const repoDir = makeTempDir("hunk-video-repo-");
  runGit(["init"], repoDir);
  runGit(["config", "user.name", "Demo"], repoDir);
  runGit(["config", "user.email", "demo@example.com"], repoDir);
  cpSync(join(repoRoot, "examples/2-mini-app-refactor/before"), repoDir, { recursive: true });
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "before"], repoDir);
  cpSync(join(repoRoot, "examples/2-mini-app-refactor/after"), repoDir, { recursive: true });
  return repoDir;
}

// ---------------------------------------------------------------------------
// Scene: line-level review — the cursor moves with j/k, `c` comments there.
// ---------------------------------------------------------------------------
async function captureReviewScene() {
  console.log("scene: review");
  const repoDir = createDemoRepo();
  const session = await launchHunk(["diff", "--mode", "stack"], { cwd: repoDir });
  try {
    await session.waitForText(/src\//, { timeout: 60_000 });
    await ensureKeyboardIsLive(session);
    await sleep(500);

    // Walk the cursor down and back up, snapping every step so playback shows
    // the line cursor actually traveling through the diff.
    let walkFrame = 0;
    const walk = async (key: "j" | "k", steps: number) => {
      for (let step = 0; step < steps; step += 1) {
        await session.press(key);
        await sleep(120);
        await snap(session, `review-walk-${String(walkFrame).padStart(2, "0")}`);
        walkFrame += 1;
      }
    };
    await walk("j", 10);
    await walk("k", 4);

    await session.press("c");
    await session.waitForText(/Draft note/, { timeout: 10_000 });
    await sleep(300);
    await snap(session, "review-draft");

    await session.type("edge case: empty task list renders a blank summary");
    await sleep(300);
    await snap(session, "review-typed");

    await session.type("\x13"); // Ctrl+S saves the note
    await session.waitForText(/Your note/, { timeout: 10_000 });
    await sleep(500);
    await snap(session, "review-note");
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------
// Scene: piped pager review — `git diff | hunk` keeps the full review UI.
// ---------------------------------------------------------------------------
async function capturePagerScene() {
  console.log("scene: pager");
  const repoDir = createDemoRepo();
  const binDir = createHunkPathWrapper(makeTempDir("hunk-video-pager-"));
  const session = await launchShell(repoDir, binDir);
  try {
    await session.waitForText(/❯/, { timeout: 15_000 });
    await sleep(300);
    await typeCommand(session, "git diff | hunk pager", { 9: "pager-typing-9", 20: "pager-typed" });
    await sleep(200);
    await session.press("enter");
    await session.waitForText(/src\/format\.ts/, { timeout: 60_000 });
    await sleep(900);
    await snap(session, "pager-review");

    // Piped pager reviews keep the full review controls: show the sidebar.
    await session.press("s");
    await sleep(700);
    await snap(session, "pager-sidebar");
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------
// Scene: authoring STML from the CLI (`hunk markup render`).
// ---------------------------------------------------------------------------
const CLI_NOTE_STML = `<h2>Cache rework</h2>
<row gap="1">
  <box border border-color="accent" padding-x="1">lookup</box>
  <text width="3"><br/>&rarr;</text>
  <box border border-color="warning" padding-x="1">miss?</box>
  <text width="3"><br/>&rarr;</text>
  <box border border-color="success" padding-x="1">rebuild once</box>
</row>
<spacer/>
<text><c fg="success">██████████████</c><c fg="subtle">░░░░░░</c> hit rate 70%</text>
<text><badge color="success">OK</badge> single-flight, <b>no stampede</b></text>
`;

async function captureMarkupCliScene() {
  console.log("scene: markup-cli");
  const demoDir = makeTempDir("hunk-video-cli-");
  writeFileSync(join(demoDir, "note.stml"), CLI_NOTE_STML);
  const binDir = createHunkPathWrapper(demoDir);

  const session = await launchShell(demoDir, binDir);
  try {
    await session.waitForText(/❯/, { timeout: 15_000 });
    await sleep(300);
    await typeCommand(session, "hunk markup render note.stml --width 72", {
      10: "cli-typing-10",
      22: "cli-typing-22",
      34: "cli-typing-34",
    });
    await sleep(200);
    await snap(session, "cli-typed");
    await session.press("enter");
    await session.waitForText(/hit rate/, { timeout: 60_000 });
    await sleep(400);
    await snap(session, "cli-rendered");
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------
// Scene: review-triage extension (custom sidebar + commands + dialogs).
// ---------------------------------------------------------------------------
async function captureTriageScene() {
  console.log("scene: triage");
  const repoDir = createDemoRepo();

  const session = await launchHunk(
    ["diff", "--extension", join(repoRoot, "examples/extensions/review-triage"), "--mode", "stack"],
    { cwd: repoDir },
  );
  try {
    await session.waitForText(/src\//, { timeout: 60_000 });
    await ensureKeyboardIsLive(session);
    await sleep(500);
    await snap(session, "triage-review");

    await session.press("y");
    await session.waitForText(/Review triage/, { timeout: 10_000 });
    await sleep(500);
    await snap(session, "triage-sidebar");

    await session.press("x");
    await session.waitForText(/Triage /, { timeout: 10_000 });
    await sleep(400);
    await snap(session, "triage-select");

    await session.press("enter"); // approved
    await session.waitForText(/optional rationale/, { timeout: 10_000 });
    await sleep(300);
    await session.type("bounded retries look right");
    await sleep(300);
    await snap(session, "triage-rationale");

    await session.press("enter");
    await sleep(700);
    await snap(session, "triage-marked");

    // Mark a second hunk so the board shows a mixed decision state.
    await session.press("]");
    await sleep(400);
    await session.press("x");
    await session.waitForText(/Triage /, { timeout: 10_000 });
    await session.press("down");
    await sleep(200);
    await session.press("enter"); // investigate
    await session.waitForText(/optional rationale/, { timeout: 10_000 });
    await session.press("enter");
    await sleep(700);
    await snap(session, "triage-board");
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------
// Scene: JSX file-view gallery (custom file previews toggled with F8).
// ---------------------------------------------------------------------------
async function captureFileViewScene(
  label: string,
  before: string,
  after: string,
  readyPattern: RegExp,
  renderedPattern: RegExp,
) {
  console.log(`scene: fileview-${label}`);
  const session = await launchHunk([
    "diff",
    "--extension",
    join(repoRoot, "examples/extensions/jsx-file-view-gallery"),
    "--mode",
    "stack",
    before,
    after,
  ]);
  try {
    await session.waitForText(readyPattern, { timeout: 60_000 });
    await ensureKeyboardIsLive(session);
    await sleep(500);
    await snap(session, `fileview-${label}-raw`);

    await session.press("f8");
    await session.waitForText(renderedPattern, { timeout: 10_000 });
    await sleep(600);
    await snap(session, `fileview-${label}-rendered`);
  } finally {
    session.close();
  }
}

// Optional comma-separated scene filter for fast iteration, e.g.
// SCENES=review bun run scripts/launch-video/capture.ts
const sceneFilter = process.env.SCENES?.split(",").map((s) => s.trim());
const wants = (name: string) => !sceneFilter || sceneFilter.includes(name);

async function main() {
  try {
    if (wants("review")) await captureReviewScene();
    if (wants("stml")) await captureStmlScene();
    if (wants("cli")) await captureMarkupCliScene();
    if (wants("pager")) await capturePagerScene();
    if (wants("triage")) await captureTriageScene();
    if (wants("fileview")) {
      await captureFileViewScene(
        "palette",
        join(repoRoot, "examples/extensions/jsx-file-view-gallery/fixtures/css-palette/before.css"),
        join(repoRoot, "examples/extensions/jsx-file-view-gallery/fixtures/css-palette/after.css"),
        /after\.css/,
        /#|palette|swatch/i,
      );
      await captureFileViewScene(
        "deps",
        join(
          repoRoot,
          "examples/extensions/jsx-file-view-gallery/fixtures/package-dependencies/before/package.json",
        ),
        join(
          repoRoot,
          "examples/extensions/jsx-file-view-gallery/fixtures/package-dependencies/after/package.json",
        ),
        /package\.json/,
        /dependencies/i,
      );
    }

    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(`wrote ${manifest.length} keyframes to ${framesDir}`);
  } finally {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  process.exit(0);
}

await main();
