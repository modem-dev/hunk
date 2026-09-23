// Measure time to Hunk's first painted review frame from process spawn, including Bun boot,
// CLI and config resolution, git bootstrap, and the OpenTUI import, by launching `hunk diff`
// inside a real PTY. In-process first-frame benchmarks start their timers after the renderer
// is already imported, so this is the only metric that sees renderer module evaluation.
// The same launch times the first syntax color and a page-down burst sent from first paint.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "perf_hooks";
import { spawn } from "tuistory/pty";

const FILE_COUNT = 8;
const LINES_PER_FILE = 80;
const WARMUP_LAUNCHES = 1;
const MEASURED_LAUNCHES = Number(process.env.HUNK_STARTUP_BENCHMARK_LAUNCHES ?? 5);
const FIRST_FRAME_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 5_000;
const OSC_11_QUERY = /\x1b\]11;\?(?:\x07|\x1b\\)/;
const OSC_11_REPLY = "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\";
// github-dark-default paints TypeScript keywords #ff7b72; its truecolor SGR marks first color.
const KEYWORD_COLOR_SGR = "38;2;255;123;114";
const PAGE_DOWN = "\x1b[6~";
// The burst covers the post-paint highlight window without scrolling past the last page.
const KEY_BURST_WINDOW_MS = 400;
const KEY_BURST_MAX_KEYS = 8;
const VALUE_TOKEN = /value\d+_\d+/g;

interface LaunchTiming {
  firstFrameMs: number;
  firstColorMs: number;
  keyAnswersMs: number[];
}

const repoRoot = resolve(import.meta.dir, "..");
const sourceEntrypoint = join(repoRoot, "packages/hunk/src/main.tsx");
const explicitExecutable = process.env.HUNK_BENCHMARK_EXECUTABLE
  ? resolve(process.env.HUNK_BENCHMARK_EXECUTABLE)
  : undefined;

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  if (proc.exitCode !== 0) {
    throw new Error(Buffer.from(proc.stderr).toString("utf8").trim() || `git ${args.join(" ")}`);
  }
}

function createFileContents(fileIndex: number, changed: boolean) {
  return Array.from({ length: LINES_PER_FILE }, (_, lineIndex) => {
    const line = lineIndex + 1;
    const value = changed && line % 10 === 0 ? line * 2 : line;
    return `export const value${fileIndex}_${line} = ${value};\n`;
  }).join("");
}

/** Build a small committed repo whose working tree carries changes in every file. */
function createWorkingTreeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-startup-benchmark-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Benchmark User");
  git(dir, "config", "user.email", "benchmark@example.com");
  for (let index = 1; index <= FILE_COUNT; index += 1) {
    writeFileSync(join(dir, `file${index}.ts`), createFileContents(index, false));
  }
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  for (let index = 1; index <= FILE_COUNT; index += 1) {
    writeFileSync(join(dir, `file${index}.ts`), createFileContents(index, true));
  }
  return dir;
}

/** Launch one review in a PTY and time its first frame, first color, and first key answer. */
async function measureLaunch(cwd: string, configHome: string): Promise<LaunchTiming> {
  const command = explicitExecutable ?? process.execPath;
  const args = explicitExecutable ? ["diff"] : ["run", sourceEntrypoint, "--", "diff"];
  let output = "";
  let exited = false;

  const start = performance.now();
  const pty = spawn(command, args, {
    cols: 140,
    rows: 40,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      XDG_CONFIG_HOME: configHome,
      HUNK_MCP_DISABLE: "1",
      HUNK_DISABLE_UPDATE_NOTICE: "1",
    },
  });
  // The PTY keeps one exit listener, so every consumer below waits on this promise.
  const exitInfo = new Promise<{ exitCode: number }>((resolveExit) => {
    pty.onExit((info) => {
      exited = true;
      resolveExit(info);
    });
  });

  const timing = new Promise<LaunchTiming>((resolveTiming, rejectTiming) => {
    const timer = setTimeout(() => {
      rejectTiming(new Error(`No review frame within ${FIRST_FRAME_TIMEOUT_MS}ms:\n${output}`));
    }, FIRST_FRAME_TIMEOUT_MS);
    let firstFrameMs: number | undefined;
    let firstColorMs: number | undefined;
    const keyAnswersMs: number[] = [];
    // A key counts as answered only when an unseen value token appears, never on a repaint.
    const seenTokens = new Set<string>();
    let keySentAt: number | undefined;
    let burstDone = false;

    const noteTokens = () => {
      let revealed = false;
      for (const match of output.matchAll(VALUE_TOKEN)) {
        if (!seenTokens.has(match[0])) {
          seenTokens.add(match[0]);
          revealed = true;
        }
      }
      return revealed;
    };
    const sendPageDown = () => {
      keySentAt = performance.now();
      pty.write(PAGE_DOWN);
    };
    const finishIfComplete = () => {
      if (firstFrameMs === undefined || firstColorMs === undefined || !burstDone) return;
      clearTimeout(timer);
      resolveTiming({ firstFrameMs, firstColorMs, keyAnswersMs });
    };

    pty.onData((data) => {
      output += data;
      // Answer the auto-theme background probe the way a real terminal would so the launch
      // measures the normal path instead of the probe's fallback timeout.
      if (OSC_11_QUERY.test(data)) {
        pty.write(OSC_11_REPLY);
      }
      const revealed = noteTokens();
      if (
        firstFrameMs === undefined &&
        output.includes("file1.ts") &&
        output.includes("value1_10")
      ) {
        firstFrameMs = performance.now() - start;
        sendPageDown();
      } else if (keySentAt !== undefined && revealed) {
        keyAnswersMs.push(performance.now() - keySentAt);
        keySentAt = undefined;
        if (
          keyAnswersMs.length < KEY_BURST_MAX_KEYS &&
          performance.now() - start - firstFrameMs! < KEY_BURST_WINDOW_MS
        ) {
          sendPageDown();
        } else {
          burstDone = true;
        }
      }
      if (firstColorMs === undefined && output.includes(KEYWORD_COLOR_SGR)) {
        firstColorMs = performance.now() - start;
      }
      finishIfComplete();
    });
    void exitInfo.then((info) => {
      clearTimeout(timer);
      rejectTiming(new Error(`Hunk exited with code ${info.exitCode} before painting:\n${output}`));
    });
  });

  try {
    return await timing;
  } finally {
    pty.write("q");
    const exitTimer = setTimeout(() => {
      if (!exited) pty.kill();
    }, EXIT_TIMEOUT_MS);
    await exitInfo;
    clearTimeout(exitTimer);
  }
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

const repoDir = createWorkingTreeRepo();
const configHome = mkdtempSync(join(tmpdir(), "hunk-startup-benchmark-config-"));

try {
  for (let launch = 0; launch < WARMUP_LAUNCHES; launch += 1) {
    await measureLaunch(repoDir, configHome);
  }
  const samples: LaunchTiming[] = [];
  for (let launch = 0; launch < MEASURED_LAUNCHES; launch += 1) {
    samples.push(await measureLaunch(repoDir, configHome));
  }
  const firstFrames = samples.map((sample) => sample.firstFrameMs);
  const firstColors = samples.map((sample) => sample.firstColorMs);
  const slowestKeys = samples.map((sample) => Math.max(...sample.keyAnswersMs));
  const keyCounts = samples.map((sample) => sample.keyAnswersMs.length);

  console.log(`METRIC startup_first_frame_ms=${median(firstFrames).toFixed(2)}`);
  console.log(`METRIC startup_first_frame_min_ms=${Math.min(...firstFrames).toFixed(2)}`);
  console.log(`METRIC startup_first_color_ms=${median(firstColors).toFixed(2)}`);
  console.log(`METRIC startup_post_paint_key_max_ms=${median(slowestKeys).toFixed(2)}`);
  console.log(`METRIC startup_post_paint_keys=${median(keyCounts).toFixed(0)}`);
  console.log(`METRIC startup_launches=${samples.length}`);
  console.log(`METRIC files=${FILE_COUNT}`);
} finally {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
}
