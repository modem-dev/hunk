// Capture helpers: drive a TUI over a real PTY (tuistory) and snap styled
// terminal keyframes to PNG (ghostty-opentui's image renderer).
//
// Bun-only: keyframe rendering resolves ghostty-opentui through tuistory's
// module graph with Bun.resolveSync, and tuistory itself needs Bun's PTY
// backend. Run capture scripts from the repository root so tuistory's subpath
// self-imports resolve against the repo's node_modules.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { launchTerminal, type Session } from "tuistory";

export type { Session };

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Options shared by every PTY launch of one capture run. */
export interface TerminalGeometry {
  cols: number;
  rows: number;
}

export interface KeyframerOptions extends TerminalGeometry {
  /** Directory PNG keyframes are written into (created if missing). */
  framesDir: string;
  /** Directory Bun resolves tuistory (and through it ghostty-opentui) from. */
  resolveFrom: string;
  /** ghostty-opentui render options; controls output resolution. */
  renderOptions?: Record<string, unknown>;
  log?: (message: string) => void;
}

export interface KeyframeEntry extends TerminalGeometry {
  name: string;
  file: string;
}

/**
 * Build a keyframe writer bound to one output directory and geometry.
 *
 * The returned `snap` renders the session's current screen (styled cells, not
 * plain text) to `<framesDir>/<name>.png`. `manifest` records this run's
 * snaps; the compositor resolves frames by name and never reads it — it
 * exists for humans debugging a capture.
 */
export async function createKeyframer(options: KeyframerOptions) {
  const {
    framesDir,
    resolveFrom,
    cols,
    rows,
    renderOptions = { fontSize: 16, lineHeight: 1.5, devicePixelRatio: 2 },
    log = console.log,
  } = options;
  mkdirSync(framesDir, { recursive: true });

  // ghostty-opentui is a transitive dependency (via tuistory), so resolve its
  // image renderer relative to tuistory's own module graph.
  const ghosttyImagePath = Bun.resolveSync(
    "ghostty-opentui/image",
    dirname(Bun.resolveSync("tuistory", resolveFrom)),
  );
  const { renderTerminalToImage } = (await import(ghosttyImagePath)) as {
    renderTerminalToImage: (data: unknown, options?: Record<string, unknown>) => Promise<Buffer>;
  };

  const manifest: KeyframeEntry[] = [];

  return {
    framesDir,
    manifest,
    async snap(session: Session, name: string) {
      const png = await renderTerminalToImage(session.getTerminalData(), renderOptions);
      const file = `${name}.png`;
      writeFileSync(join(framesDir, file), png);
      manifest.push({ name, file, cols, rows });
      log(`  snap ${name}`);
    },
    writeManifest(path: string) {
      writeFileSync(path, JSON.stringify(manifest, null, 2));
    },
  };
}

export type Keyframer = Awaited<ReturnType<typeof createKeyframer>>;

export interface LaunchAppOptions extends TerminalGeometry {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}

/** Launch the application under capture in a PTY. */
export async function launchApp(options: LaunchAppOptions) {
  return launchTerminal({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
    env: { ...process.env, ...options.env },
  });
}

export interface LaunchShellOptions extends TerminalGeometry {
  cwd: string;
  /** Directories prepended to PATH (e.g. a wrapper bin dir). */
  pathPrepend?: string[];
  /** Prompt string; defaults to a magenta `❯ `. */
  prompt?: string;
  env?: Record<string, string | undefined>;
}

/** Launch an interactive bash with a clean prompt for shell-demo scenes. */
export async function launchShell(options: LaunchShellOptions) {
  const pathPrefix = options.pathPrepend?.length ? `${options.pathPrepend.join(":")}:` : "";
  return launchTerminal({
    command: "/bin/bash",
    args: ["--noprofile", "--norc", "-i"],
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
    env: {
      ...process.env,
      PATH: `${pathPrefix}${process.env.PATH}`,
      PS1: options.prompt ?? "\\[\\e[38;5;213m\\]❯\\[\\e[0m\\] ",
      TERM: "xterm-256color",
      ...options.env,
    },
  });
}

/**
 * Write an executable wrapper so shell scenes can show a real command name
 * (`hunk …`) while actually exec-ing a dev invocation.
 */
export function createCommandWrapper(binDir: string, name: string, exec: string[]) {
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, name);
  const quoted = exec.map((part) => `"${part}"`).join(" ");
  writeFileSync(wrapper, `#!/bin/bash\nexec ${quoted} "$@"\n`);
  chmodSync(wrapper, 0o755);
  return binDir;
}

/** Type a shell command character by character, snapping the requested frames. */
export async function typeCommand(
  session: Session,
  keyframer: Keyframer,
  command: string,
  snapAt: Record<number, string>,
) {
  let index = 0;
  for (const char of command) {
    session.writeRaw(char);
    await sleep(30);
    const name = snapAt[index];
    if (name) {
      await keyframer.snap(session, name);
    }
    index += 1;
  }
}

export interface KeyboardProbe {
  /** Key that opens an unmistakable, dismissable surface (e.g. a help overlay). */
  probeKey: Parameters<Session["press"]>[0];
  /** Text proving the probe landed. */
  expect: RegExp;
  /** Key that dismisses the surface again. */
  dismissKey: Parameters<Session["press"]>[0];
}

/**
 * Prove the app is accepting keys before scripted presses.
 *
 * The first key after startup can land before any handler is bound and be
 * silently dropped — a real race that reads as a broken shortcut. Toggling a
 * cheap surface with an unmistakable effect proves keys are live.
 */
export async function ensureKeyboardIsLive(session: Session, probe: KeyboardProbe) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await session.press(probe.probeKey);
    try {
      await session.waitForText(probe.expect, { timeout: 2_000 });
      await session.press(probe.dismissKey);
      await sleep(300);
      return;
    } catch {
      // Key dropped before the handler was bound; retry.
    }
  }
  throw new Error("The app never reacted to a keypress.");
}

/**
 * Build a scene filter from a comma-separated env value, e.g.
 * `SCENES=review,pager`. With no value every scene runs.
 */
export function makeSceneFilter(envValue: string | undefined) {
  const filter = envValue?.split(",").map((scene) => scene.trim());
  return (name: string) => !filter || filter.includes(name);
}
