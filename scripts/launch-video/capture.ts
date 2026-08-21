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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createKeyframer,
  ensureKeyboardIsLive,
  launchApp,
  launchShell,
  makeSceneFilter,
  sleep,
  typeCommand,
  type KeyboardProbe,
} from "@hunk/term-video/capture";
import {
  createHunkCommandWrapper,
  driveGestures,
  launchAgentDrivenHunk,
  type AgentGesture,
} from "./agentDriver.ts";
import {
  buildReportModule,
  createAgentDemoRepo,
  createDemoRepo,
  locateNeedle,
} from "./demoContent.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hunkEntrypoint = join(repoRoot, "src/main.tsx");

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

async function launchHunk(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
) {
  return launchApp({
    command: process.execPath,
    args: ["run", hunkEntrypoint, "--", ...args],
    cwd: options.cwd ?? repoRoot,
    cols: COLS,
    rows: ROWS,
    env: options.env ?? hunkEnv,
  });
}

/**
 * Interactive bash with a real `hunk` command on PATH for shell scenes.
 *
 * Agent-driven scenes pass their own env so on-camera commands reach the same
 * isolated daemon the TUI registered with.
 */
async function launchHunkShell(cwd: string, env: Record<string, string | undefined> = hunkEnv) {
  const binDir = createHunkCommandWrapper(
    join(makeTempDir("hunk-video-bin-"), "bin"),
    hunkEntrypoint,
  );
  return launchShell({
    cwd,
    cols: COLS,
    rows: ROWS,
    pathPrepend: [binDir],
    // macOS bash greets every interactive session with a zsh migration notice;
    // it would be the first thing on camera in every shell scene.
    env: { BASH_SILENCE_DEPRECATION_WARNING: "1", ...env },
  });
}

// What every demo-repo builder needs: the `examples/` source and this run's
// scratch-dir factory, so temp cleanup stays in one place.
const demoRepoOptions = { repoRoot, makeTempDir };

// ---------------------------------------------------------------------------
// Scene: agent-driven review — a coding agent steers a live session over the
// `hunk session` CLI: line-exact navigation, attention marks, and a note,
// some typed on camera and some issued silently in the background.
// ---------------------------------------------------------------------------
async function captureAgentScene() {
  console.log("scene: agent");
  const repoDir = createAgentDemoRepo(demoRepoOptions);

  // Every offset the scene points at is computed from the generated content,
  // so the shots stay aimed at the right code when that content changes.
  const comparator = locateNeedle(buildReportModule("after"), "openCount >= policy.limit");
  const formatModule = readFileSync(
    join(repoRoot, "examples/2-mini-app-refactor/after/src/format.ts"),
    "utf8",
  );
  const ternary = locateNeedle(formatModule, 'task.state === "doing" ? "[active]" : "[queued]"');

  const drive = await launchAgentDrivenHunk({
    repoDir,
    args: ["diff", "--mode", "stack"],
    repoRoot,
    hunkEntrypoint,
    cols: COLS,
    rows: ROWS,
    makeTempDir,
    keyboardProbe: HUNK_KEYBOARD_PROBE,
    baseEnv: { XDG_CONFIG_HOME: configHome, HUNK_DISABLE_UPDATE_NOTICE: "1" },
    launchShell: launchHunkShell,
  });
  try {
    await sleep(500);
    await snap(drive.session, "agent-review");

    // On-camera commands select the session with `--repo .` from the demo
    // repo; off-camera ones use its absolute path.
    const highlightReport = [
      "highlight",
      "add",
      "--repo",
      repoDir,
      "--file",
      "src/report.ts",
      "--new-line",
      String(comparator.line),
      "--start",
      String(comparator.start),
      "--end",
      String(comparator.end),
    ];

    const gestures: AgentGesture[] = [
      // 1. The CLI surface itself: one live session, listed from the shell.
      {
        kind: "shell",
        commandText: "hunk session list",
        typingSnaps: { 6: "agent-list-typing-06", 13: "agent-list-typing-13" },
        shellSnap: "agent-shell-list",
        expect: /files:/,
      },
      // 2. Old granularity: hunk navigation parks at the top of the tall hunk.
      {
        kind: "silent",
        args: ["navigate", "--repo", repoDir, "--file", "src/report.ts", "--hunk", "1"],
        terminalSnap: "agent-hunk-nav",
      },
      // 3. New granularity: a line target lands the buried comparator exactly.
      {
        kind: "shell",
        commandText: `hunk session navigate --repo . --file src/report.ts --new-line ${comparator.line}`,
        typingSnaps: { 20: "agent-nav-typing-20", 44: "agent-nav-typing-44" },
        shellSnap: "agent-shell-nav",
        terminalSnap: "agent-line-nav",
        expect: /Revealed/,
      },
      // 4. Attention mark: light up the comparator we just landed on.
      {
        kind: "silent",
        args: [...highlightReport, "--tone", "warning"],
        terminalSnap: "agent-mark-warning",
      },
      // 5. Tone is paint only: the same range repainted as `current`, viewport
      // untouched — this beat isolates --tone from --focus.
      { kind: "silent", args: ["highlight", "clear", "--repo", repoDir], settleMs: 0 },
      {
        kind: "silent",
        args: [...highlightReport, "--tone", "current"],
        terminalSnap: "agent-mark-tone",
      },
      // 6. Marks move with the narration: clear, then mark + focus a second file.
      { kind: "silent", args: ["highlight", "clear", "--repo", repoDir], settleMs: 0 },
      {
        kind: "shell",
        commandText:
          `hunk session highlight add --repo . --file src/format.ts --new-line ${ternary.line}` +
          ` --start ${ternary.start} --end ${ternary.end} --tone current --focus`,
        typingSnaps: { 26: "agent-mark-typing-26", 62: "agent-mark-typing-62" },
        shellSnap: "agent-shell-mark",
        terminalSnap: "agent-mark-focus",
        expect: /Marked/,
      },
      // 7. A mark is ephemeral; a comment persists the same explanation.
      {
        kind: "silent",
        args: [
          "comment",
          "add",
          "--repo",
          repoDir,
          "--file",
          "src/format.ts",
          "--new-line",
          String(ternary.line),
          "--summary",
          "Queued tasks now render as [queued] instead of falling through to the done label.",
          "--focus",
        ],
        terminalSnap: "agent-comment",
        settleMs: 900,
      },
      // 8. Clear closes the loop: marks gone, the note stays.
      {
        kind: "silent",
        args: ["highlight", "clear", "--repo", repoDir],
        terminalSnap: "agent-clear",
      },
    ];

    await driveGestures(drive, keyframer, gestures);
  } finally {
    drive.close();
  }
}

// ---------------------------------------------------------------------------
// Scene: line-level review — the cursor moves with j/k, `c` comments there.
// ---------------------------------------------------------------------------
async function captureReviewScene() {
  console.log("scene: review");
  const repoDir = createDemoRepo(demoRepoOptions);
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
  const repoDir = createDemoRepo(demoRepoOptions);
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
  const repoDir = createDemoRepo(demoRepoOptions);

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
    if (wants("agent")) await captureAgentScene();
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
