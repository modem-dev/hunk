// Hunk video scenes: drives real Hunk sessions in a headless PTY
// and captures styled keyframes as PNGs via @hunk/term-video. Run from the
// repo root with Bun:
//
//   bun run scripts/launch-video/capture.ts [outDir]
//
// Output: <outDir>/frames/*.png. manifest.json is a capture-side inventory of
// this run only — compose.mjs resolves frames by name from its SHOTS table and
// ignores it, and after a SCENES= run the manifest is partial while frames/
// stays cumulative.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createCommandWrapper,
  createKeyframer,
  ensureKeyboardIsLive,
  launchApp,
  launchShell,
  makeSceneFilter,
  sleep,
  typeCommand,
  type KeyboardProbe,
} from "@hunk/term-video/capture";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hunkEntrypoint = join(repoRoot, "packages/hunk/src/main.tsx");

const outDir = resolve(process.argv[2] ?? join(repoRoot, ".video-work"));

// One shared terminal geometry so every scene composes into the same window.
const COLS = 140;
const ROWS = 32;

const keyframer = await createKeyframer({
  framesDir: join(outDir, "frames"),
  resolveFrom: repoRoot,
  cols: COLS,
  rows: ROWS,
});
const snap = keyframer.snap.bind(keyframer);

const tempDirs: string[] = [];
function makeTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// Isolated config home so captures always show built-in defaults.
const configHome = makeTempDir("hunk-video-config-");
const hunkEnv = {
  XDG_CONFIG_HOME: configHome,
  HUNK_MCP_DISABLE: "1",
  HUNK_DISABLE_UPDATE_NOTICE: "1",
};

// Hunk's help overlay is the cheap, unmistakable probe surface.
const HUNK_KEYBOARD_PROBE: KeyboardProbe = {
  probeKey: "?",
  expect: /Controls help/,
  dismissKey: "escape",
};

function runGit(args: string[], cwd: string) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (proc.status !== 0) {
    throw new Error(proc.stderr.trim() || `git ${args.join(" ")} failed`);
  }
}

async function launchHunk(args: string[], options: { cwd?: string } = {}) {
  return launchApp({
    command: process.execPath,
    args: ["run", hunkEntrypoint, "--", ...args],
    cwd: options.cwd ?? repoRoot,
    cols: COLS,
    rows: ROWS,
    env: hunkEnv,
  });
}

/** Interactive bash with a real `hunk` command on PATH for shell scenes. */
async function launchHunkShell(cwd: string) {
  const binDir = createCommandWrapper(join(makeTempDir("hunk-video-bin-"), "bin"), "hunk", [
    process.execPath,
    "run",
    hunkEntrypoint,
    "--",
  ]);
  return launchShell({ cwd, cols: COLS, rows: ROWS, pathPrepend: [binDir], env: hunkEnv });
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
    await ensureKeyboardIsLive(session, HUNK_KEYBOARD_PROBE);
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
    await ensureKeyboardIsLive(session, HUNK_KEYBOARD_PROBE);
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

  const session = await launchHunkShell(demoDir);
  try {
    await session.waitForText(/❯/, { timeout: 15_000 });
    await sleep(300);
    await typeCommand(session, keyframer, "hunk markup render note.stml --width 72", {
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
// Scene: piped pager review — `git diff | hunk pager` keeps the full UI.
// ---------------------------------------------------------------------------
async function capturePagerScene() {
  console.log("scene: pager");
  const repoDir = createDemoRepo();
  const session = await launchHunkShell(repoDir);
  try {
    await session.waitForText(/❯/, { timeout: 15_000 });
    await sleep(300);
    await typeCommand(session, keyframer, "git diff | hunk pager", {
      9: "pager-typing-9",
      20: "pager-typed",
    });
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
    await ensureKeyboardIsLive(session, HUNK_KEYBOARD_PROBE);
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
    await ensureKeyboardIsLive(session, HUNK_KEYBOARD_PROBE);
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
const wants = makeSceneFilter(process.env.SCENES);

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

    keyframer.writeManifest(join(outDir, "manifest.json"));
    console.log(`wrote ${keyframer.manifest.length} keyframes to ${keyframer.framesDir}`);
  } finally {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  process.exit(0);
}

await main();
