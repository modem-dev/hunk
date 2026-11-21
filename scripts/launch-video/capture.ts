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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  TZ: "UTC",
};

// Hunk's help overlay is the cheap, unmistakable probe surface.
const HUNK_KEYBOARD_PROBE: KeyboardProbe = {
  probeKey: "?",
  expect: /Controls help/,
  dismissKey: "escape",
};

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const proc = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (proc.status !== 0) {
    throw new Error(proc.stderr.trim() || `git ${args.join(" ")} failed`);
  }
}

async function launchHunk(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  return launchApp({
    command: process.execPath,
    args: ["run", hunkEntrypoint, "--", ...args],
    cwd: options.cwd ?? repoRoot,
    cols: COLS,
    rows: ROWS,
    env: { ...hunkEnv, ...options.env },
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

/** Build a deterministic Git history with enough depth and dates for the history browser. */
function createHistoryDemoRepo() {
  const repoDir = join(makeTempDir("hunk-video-history-"), "hunk-history-demo");
  mkdirSync(repoDir);
  runGit(["init", "-q", "-b", "main"], repoDir);
  runGit(["config", "user.name", "Hunk Team"], repoDir);
  runGit(["config", "user.email", "hello@hunk.dev"], repoDir);

  const utcBaseDate = new Date();
  utcBaseDate.setUTCHours(0, 0, 0, 0);
  /** Keep fixture ages current while preserving stable UTC day groups. */
  function utcDate(daysAgo: number, hour: number, minute: number) {
    const date = new Date(utcBaseDate);
    date.setUTCHours(hour, minute, 0, 0);
    date.setUTCDate(date.getUTCDate() - daysAgo);
    return date.toISOString();
  }
  const commits = [
    ["Start terminal review workspace", utcDate(5, 10, 0)],
    ["Render unified diff rows", utcDate(4, 9, 15)],
    ["Add keyboard review navigation", utcDate(4, 14, 40)],
    ["Show inline review notes", utcDate(3, 11, 20)],
    ["Add multiline review comments", utcDate(2, 8, 30)],
    ["Make history range-selectable", utcDate(2, 15, 10)],
    ["Preserve routed view preferences", utcDate(1, 12, 25)],
    ["Polish interactive Git history", utcDate(1, 17, 45)],
  ] as const;

  for (const [index, [subject, date]] of commits.entries()) {
    const exports = commits
      .slice(0, index + 1)
      .map(
        ([commitSubject], exportIndex) =>
          `export const feature${exportIndex + 1} = ${JSON.stringify(commitSubject)};`,
      )
      .join("\n");
    writeFileSync(join(repoDir, "history.ts"), `${exports}\n`);
    writeFileSync(
      join(repoDir, "README.md"),
      `# Hunk history demo\n\nCurrent milestone: ${subject}.\n`,
    );
    runGit(["add", "history.ts", "README.md"], repoDir);
    runGit(["commit", "-qm", subject], repoDir, {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
  }

  return repoDir;
}

const TASKBOARD_README = `# taskboard

A tiny task tracker used to demo Hunk.

- \`src/tasks.ts\` holds the seed data
- \`src/render.ts\` draws the board
- \`bun run demo\` prints a summary
`;

const TASKBOARD_PACKAGE = `${JSON.stringify(
  {
    name: "taskboard",
    version: "0.4.0",
    type: "module",
    scripts: { demo: "bun run src/main.ts", test: "bun test" },
  },
  null,
  2,
)}\n`;

const TASKBOARD_RENDER = `import type { Task } from "./tasks";

/** Column order and display labels for the board. */
const COLUMNS = [
  { state: "todo", label: "To do" },
  { state: "doing", label: "In progress" },
  { state: "done", label: "Done" },
] as const;

export interface BoardOptions {
  width: number;
  showOwners?: boolean;
}

/** Render tasks as fixed-width board columns, one card per line. */
export function renderBoard(tasks: Task[], options: BoardOptions): string[] {
  const columnWidth = Math.floor(options.width / COLUMNS.length) - 2;
  const columns = COLUMNS.map(({ state, label }) => {
    const cards = tasks
      .filter((task) => task.state === state)
      .map((task) => formatCard(task, columnWidth, options.showOwners));
    return [label.toUpperCase().padEnd(columnWidth), ...cards];
  });

  const height = Math.max(...columns.map((column) => column.length));
  const rows: string[] = [];
  for (let row = 0; row < height; row += 1) {
    rows.push(columns.map((column) => (column[row] ?? "").padEnd(columnWidth)).join("  "));
  }
  return rows;
}

function formatCard(task: Task, width: number, showOwners = true): string {
  const marker = task.blocked ? "!" : "-";
  const owner = showOwners ? \` @\${task.owner}\` : "";
  const text = \`\${marker} \${task.title}\${owner}\`;
  return text.length > width ? \`\${text.slice(0, width - 1)}…\` : text;
}
`;

/** Write the taskboard demo project's "before" tree into an existing directory. */
function writeTaskboardBase(dir: string) {
  cpSync(join(repoRoot, "examples/2-mini-app-refactor/before"), dir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), TASKBOARD_README);
  writeFileSync(join(dir, "package.json"), TASKBOARD_PACKAGE);
  writeFileSync(join(dir, "src/render.ts"), TASKBOARD_RENDER);
}

/**
 * Build a named `taskboard` Git repo with one committed baseline. It lives at
 * a fixed `<tmp>/demo/taskboard` path, recreated per scene, because status
 * and open headers print the full path and a random temp name reads as noise.
 */
function createTaskboardRepo() {
  const parent = join(tmpdir(), "demo");
  rmSync(parent, { recursive: true, force: true });
  tempDirs.push(parent);
  const repoDir = join(parent, "taskboard");
  mkdirSync(repoDir, { recursive: true });
  runGit(["init", "-q", "-b", "main"], repoDir);
  runGit(["config", "user.name", "Hunk Team"], repoDir);
  runGit(["config", "user.email", "hello@hunk.dev"], repoDir);
  writeTaskboardBase(repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-qm", "Start taskboard"], repoDir);
  return { parent, repoDir };
}

/**
 * Build a taskboard repo with staged, unstaged, and untracked work plus a
 * sibling worktree, so the status view has every group to show.
 */
function createTaskboardStatusRepo() {
  const { parent, repoDir } = createTaskboardRepo();
  const after = join(repoRoot, "examples/2-mini-app-refactor/after");

  // Staged: the refactored main entry point and tasks module.
  cpSync(join(after, "src/main.ts"), join(repoDir, "src/main.ts"));
  cpSync(join(after, "src/tasks.ts"), join(repoDir, "src/tasks.ts"));
  runGit(["add", "src/main.ts", "src/tasks.ts"], repoDir);

  // Mixed: staged formatter change with a further unstaged edit on top.
  cpSync(join(after, "src/format.ts"), join(repoDir, "src/format.ts"));
  runGit(["add", "src/format.ts"], repoDir);
  writeFileSync(
    join(repoDir, "src/format.ts"),
    `${readFileSync(join(after, "src/format.ts"), "utf8")}\nexport const EMPTY_SUMMARY = "No tasks yet";\n`,
  );

  // Unstaged: a render tweak and the demo test.
  writeFileSync(
    join(repoDir, "src/render.ts"),
    TASKBOARD_RENDER.replace(
      'const marker = task.blocked ? "!" : "-";',
      'const marker = task.blocked ? "⚠" : "•";',
    ),
  );
  cpSync(join(after, "test/main.demo.ts"), join(repoDir, "test/main.demo.ts"));

  // Untracked: the new grouping helper and a scratch note.
  cpSync(join(after, "src/groupTasks.ts"), join(repoDir, "src/groupTasks.ts"));
  writeFileSync(join(repoDir, "NOTES.md"), "- group tasks by owner before rendering\n");

  // Sibling worktree on a fix branch with its own uncommitted change.
  const siblingDir = join(parent, "taskboard-empty-state");
  runGit(["worktree", "add", "-q", "-b", "fix/empty-state", siblingDir], repoDir);
  writeFileSync(
    join(siblingDir, "src/render.ts"),
    TASKBOARD_RENDER.replace(
      "  const height = Math.max",
      '  if (tasks.length === 0) return ["No tasks yet"];\n\n  const height = Math.max',
    ),
  );

  return repoDir;
}

// ---------------------------------------------------------------------------
// Scene: interactive Git history, visual range selection, and comparison review.
// ---------------------------------------------------------------------------
async function captureHistoryScene() {
  console.log("scene: history");
  const repoDir = createHistoryDemoRepo();
  const session = await launchHunk(["log", "--max-count", "10", "--no-extensions"], {
    cwd: repoDir,
  });
  try {
    await session.waitForText(/Polish interactive Git history/, { timeout: 60_000 });
    await ensureKeyboardIsLive(session, HUNK_KEYBOARD_PROBE);
    await sleep(600);
    await snap(session, "history-overview");

    for (let step = 0; step < 3; step += 1) {
      await session.press("j");
      await sleep(180);
      await snap(session, `history-walk-${step + 1}`);
    }

    await session.press("v");
    await session.waitForText(/1 commit selected/, { timeout: 10_000 });
    await sleep(250);
    await snap(session, "history-range-1");

    for (let selected = 2; selected <= 4; selected += 1) {
      await session.press("j");
      await session.waitForText(new RegExp(`${selected} commits selected`), { timeout: 10_000 });
      await sleep(180);
      await snap(session, `history-range-${selected}`);
    }

    await session.press("enter");
    await session.waitForText(/history\.ts/, { timeout: 60_000 });
    await sleep(800);
    await snap(session, "history-comparison");
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------
// Scene: line-level review — the cursor moves with j/k, `c` comments there.
// ---------------------------------------------------------------------------
async function captureReviewScene() {
  console.log("scene: review");
  const repoDir = createDemoRepo();
  const session = await launchHunk(["diff", "--mode", "unified"], { cwd: repoDir });
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
    "unified",
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
    [
      "diff",
      "--extension",
      join(repoRoot, "examples/extensions/review-triage"),
      "--mode",
      "unified",
    ],
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
    "unified",
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

// ---------------------------------------------------------------------------
// Scene: `hunk open` — browse a project tree and read a complete file.
// ---------------------------------------------------------------------------
async function captureOpenScene() {
  console.log("scene: open");
  const repoDir = createTaskboardStatusRepo();
  const session = await launchHunk(["open"], { cwd: repoDir });
  try {
    await session.waitForText(/README\.md/, { timeout: 60_000 });
    await ensureKeyboardIsLive(session, HUNK_KEYBOARD_PROBE);
    await sleep(800);
    await snap(session, "open-overview");

    // One snap per keypress: select src/, expand it, walk to render.ts.
    let step = 0;
    const press = async (key: Parameters<typeof session.press>[0], wait = 220) => {
      await session.press(key);
      await sleep(wait);
      await snap(session, `open-tree-${step}`);
      step += 1;
    };
    await press("j");
    await press("enter", 500);
    await session.waitForText(/render\.ts/, { timeout: 10_000 });
    for (let i = 0; i < 4; i += 1) await press("j");

    await session.press("enter");
    await session.waitForText(/renderBoard/, { timeout: 30_000 });
    await sleep(900);
    await snap(session, "open-document");

    // Focus the document and step through it.
    await session.press("tab");
    await sleep(300);
    for (let i = 0; i < 6; i += 1) {
      await session.press("pagedown");
      await sleep(260);
      await snap(session, `open-scroll-${i}`);
    }
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------
// Scene: `hunk status` — live workspace compass into full reviews.
// ---------------------------------------------------------------------------
async function captureStatusScene() {
  console.log("scene: status");
  const repoDir = createTaskboardStatusRepo();
  const session = await launchHunk(["status"], { cwd: repoDir });
  try {
    await session.waitForText(/Other worktrees/, { timeout: 60_000 });
    await ensureKeyboardIsLive(session, HUNK_KEYBOARD_PROBE);
    await sleep(800);
    await snap(session, "status-overview");

    // Walk down through every tracked and untracked row to the sibling worktree.
    for (let i = 0; i < 6; i += 1) {
      await session.press("down");
      await sleep(220);
      await snap(session, `status-walk-${i}`);
    }

    await session.press("enter");
    await session.waitForText(/fix\/empty-state/, { timeout: 30_000 });
    await sleep(1500);
    await snap(session, "status-sibling");

    await session.press("escape");
    await sleep(1200);
    for (let i = 0; i < 6; i += 1) {
      await session.press("up");
      await sleep(120);
    }
    await sleep(400);
    await snap(session, "status-back");

    await session.press("enter");
    await session.waitForText(/working tree/, { timeout: 30_000 });
    await sleep(1800);
    await snap(session, "status-diff");
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------
// Scene: pane-aware auto layout — closing the files pane switches to split.
// ---------------------------------------------------------------------------
async function captureLayoutScene() {
  console.log("scene: layout");
  const { repoDir } = createTaskboardRepo();
  cpSync(join(repoRoot, "examples/2-mini-app-refactor/after"), repoDir, { recursive: true });
  const layoutConfigHome = makeTempDir("hunk-video-layout-config-");
  mkdirSync(join(layoutConfigHome, "hunk"), { recursive: true });
  writeFileSync(join(layoutConfigHome, "hunk", "config.toml"), "auto_split_min_width = 120\n");
  const session = await launchHunk(["diff"], {
    cwd: repoDir,
    env: { XDG_CONFIG_HOME: layoutConfigHome },
  });
  try {
    await session.waitForText(/src\//, { timeout: 60_000 });
    await ensureKeyboardIsLive(session, HUNK_KEYBOARD_PROBE);
    await sleep(800);
    await snap(session, "layout-split");

    await session.press("s");
    await sleep(900);
    await snap(session, "layout-unified");

    await session.press("s");
    await sleep(900);
    await snap(session, "layout-split-again");
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------
// Scene: version-matched agent skills printed by the installed binary.
// ---------------------------------------------------------------------------
async function captureSkillScene() {
  console.log("scene: skill");
  const { repoDir } = createTaskboardRepo();
  const session = await launchHunkShell(repoDir);
  try {
    await session.waitForText(/❯/, { timeout: 15_000 });
    await sleep(300);
    await typeCommand(
      session,
      keyframer,
      "hunk skill show hunk-review | head -n 12 | fold -sw 88",
      {
        8: "skill-typing-8",
        30: "skill-typing-30",
      },
    );
    await sleep(200);
    await snap(session, "skill-typed");
    await session.press("enter");
    await session.waitForText(/## Workflow/, { timeout: 60_000 });
    await sleep(600);
    await snap(session, "skill-output");
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------
// Scene: Bash completion for commands and enumerated flag values.
// ---------------------------------------------------------------------------
async function captureCompletionScene() {
  console.log("scene: completion");
  const { repoDir } = createTaskboardRepo();
  const session = await launchHunkShell(repoDir);
  try {
    await session.waitForText(/❯/, { timeout: 15_000 });
    // Clear with a raw escape: the PTY's TERM has no terminfo entry for `clear`.
    session.writeRaw("source <(hunk completion bash); printf '\\033[H\\033[2J\\033[3J'\r");
    await sleep(2500);

    await typeCommand(session, keyframer, "hunk ", { 4: "completion-typed" });
    await sleep(200);
    session.writeRaw("\t\t");
    await sleep(2500);
    await snap(session, "completion-commands");

    session.writeRaw("diff --mode ");
    await sleep(300);
    await snap(session, "completion-mode-typed");
    session.writeRaw("\t\t");
    await sleep(2500);
    await snap(session, "completion-modes");
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------
// Scene: conflict diffs — `hunk diff` during a paused merge.
// ---------------------------------------------------------------------------
async function captureConflictScene() {
  console.log("scene: conflict");
  const { repoDir } = createTaskboardRepo();
  const renderPath = join(repoDir, "src/render.ts");
  const commitRender = (message: string, from: string, to: string) => {
    writeFileSync(renderPath, readFileSync(renderPath, "utf8").replace(from, to));
    runGit(["commit", "-qam", message], repoDir);
  };

  // Both branches restyle the same two lines of the board renderer.
  runGit(["switch", "-qc", "glyph-markers"], repoDir);
  commitRender(
    "Use glyph markers",
    'const marker = task.blocked ? "!" : "-";',
    'const marker = task.blocked ? "⚠" : "•";',
  );
  commitRender(
    "Rename progress column",
    '{ state: "doing", label: "In progress" }',
    '{ state: "doing", label: "Doing" }',
  );
  runGit(["switch", "-q", "main"], repoDir);
  commitRender(
    "Mark blocked tasks in text",
    'const marker = task.blocked ? "!" : "-";',
    'const marker = task.blocked ? "[blocked]" : "[ ]";',
  );
  commitRender(
    "Clarify progress column",
    '{ state: "doing", label: "In progress" }',
    '{ state: "doing", label: "Active" }',
  );
  const merge = spawnSync("git", ["merge", "glyph-markers"], { cwd: repoDir, encoding: "utf8" });
  if (merge.status === 0) throw new Error("expected the demo merge to conflict");

  const session = await launchHunk(["diff", "--mode", "unified"], { cwd: repoDir });
  try {
    await session.waitForText(/render\.ts/, { timeout: 60_000 });
    await ensureKeyboardIsLive(session, HUNK_KEYBOARD_PROBE);
    await sleep(900);
    await snap(session, "conflict-review");
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------
// Scene: scroll_off — stepping the cursor keeps rows of context below it.
// ---------------------------------------------------------------------------
async function captureScrollOffScene() {
  console.log("scene: scrolloff");
  const { repoDir } = createTaskboardRepo();
  cpSync(join(repoRoot, "examples/2-mini-app-refactor/after"), repoDir, { recursive: true });
  const session = await launchHunk(["diff", "--mode", "unified"], { cwd: repoDir });
  try {
    await session.waitForText(/src\//, { timeout: 60_000 });
    await ensureKeyboardIsLive(session, HUNK_KEYBOARD_PROBE);
    await sleep(800);
    await snap(session, "scrolloff-start");

    // One snap per press so playback shows the view following the cursor.
    for (let step = 0; step < 34; step += 1) {
      await session.press("j");
      await sleep(140);
      await snap(session, `scrolloff-step-${String(step).padStart(2, "0")}`);
    }
  } finally {
    session.close();
  }
}

// The current storyboard is the 0.24 release roundup; opt into other reusable
// scenes with a comma-separated override, e.g. SCENES=status,skill,history.
const wants = makeSceneFilter(process.env.SCENES ?? "open,layout,conflict,scrolloff,completion");

async function main() {
  try {
    if (wants("open")) await captureOpenScene();
    if (wants("status")) await captureStatusScene();
    if (wants("layout")) await captureLayoutScene();
    if (wants("skill")) await captureSkillScene();
    if (wants("completion")) await captureCompletionScene();
    if (wants("conflict")) await captureConflictScene();
    if (wants("scrolloff")) await captureScrollOffScene();
    if (wants("history")) await captureHistoryScene();
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
