// Agent-driven capture glue: runs a Hunk TUI against a private daemon and
// drives it the way a coding agent does — through real `hunk session …`
// commands, either silently in the background or typed on camera in a shell
// that shares the same daemon.
//
// Hunk-side glue on purpose: it knows Hunk's dev entrypoint, session CLI, and
// daemon discovery env, none of which belong in @hunk/term-video.
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  createCommandWrapper,
  ensureKeyboardIsLive,
  launchApp,
  sleep,
  typeCommand,
  type Keyframer,
  type KeyboardProbe,
  type Session,
} from "@hunk/term-video/capture";

/** Asks the OS for a currently free loopback port. */
export async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not determine a free port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

export interface AgentDriverOptions {
  /** Repo the TUI reviews; the driver shell runs here too. */
  repoDir: string;
  /** Arguments after `hunk`, e.g. `["diff", "--mode", "stack"]`. */
  args: string[];
  /** Repo root the dev entrypoint runs from (tuistory self-imports need it). */
  repoRoot: string;
  /** Path to Hunk's dev entrypoint (`src/main.tsx`). */
  hunkEntrypoint: string;
  cols: number;
  rows: number;
  /** Scratch-dir factory owned by the caller so temp cleanup stays in one place. */
  makeTempDir: (prefix: string) => string;
  /** Probe proving the TUI accepts keys before scripted presses. */
  keyboardProbe: KeyboardProbe;
  /** Env shared with the rest of the capture (config home, update notice, …). */
  baseEnv?: Record<string, string>;
  /** Content proving the review rendered; defaults to a file path in the tree. */
  readyPattern?: RegExp;
  /** Builds the on-camera shell with a real `hunk` on PATH and this env. */
  launchShell?: (cwd: string, env: Record<string, string>) => Promise<Session>;
}

/** A live TUI plus the agent-side handles that drive it. */
export interface AgentDrive {
  /** The TUI session under capture. */
  session: Session;
  /** Session id the daemon registered for this TUI. */
  sessionId: string;
  /** Isolated daemon env every driver process shares. */
  env: Record<string, string>;
  /** Runs `hunk session …` against this scene's private daemon. */
  run: (args: string[]) => string;
  /** Runs `hunk session … --json` and parses the response. */
  runJson: <T>(args: string[]) => T;
  /** Opens (once) the on-camera shell that talks to the same daemon. */
  launchAgentShell: () => Promise<Session>;
  /** The on-camera shell, or undefined until `launchAgentShell` runs. */
  shell?: Session;
  close: () => void;
}

/**
 * Launches a Hunk TUI wired to a daemon nobody else can see, and waits until
 * the session is registered and drivable.
 *
 * Isolation is the whole point: a scratch `XDG_RUNTIME_DIR` keeps discovery
 * private and an OS-assigned `HUNK_MCP_PORT` keeps the daemon itself private,
 * so a capture never collides with a developer's live daemon, a concurrent
 * capture, or a leftover process. `HUNK_MCP_DISABLE` must stay unset — it
 * would kill the broker registration this whole scene depends on.
 */
export async function launchAgentDrivenHunk(options: AgentDriverOptions): Promise<AgentDrive> {
  const env: Record<string, string> = {
    ...options.baseEnv,
    XDG_RUNTIME_DIR: options.makeTempDir("hunk-video-runtime-"),
    HUNK_MCP_PORT: String(await findFreePort()),
  };

  const run = (args: string[]) => {
    const proc = spawnSync(
      process.execPath,
      ["run", options.hunkEntrypoint, "--", "session", ...args],
      { cwd: options.repoRoot, encoding: "utf8", env: { ...process.env, ...env } },
    );
    if (proc.status !== 0) {
      throw new Error(proc.stderr.trim() || `hunk session ${args.join(" ")} failed`);
    }
    return proc.stdout;
  };

  const runJson = <T>(args: string[]) => JSON.parse(run(args)) as T;

  const session = await launchApp({
    command: process.execPath,
    args: ["run", options.hunkEntrypoint, "--", ...options.args],
    cwd: options.repoDir,
    cols: options.cols,
    rows: options.rows,
    env,
  });

  let shell: Session | undefined;
  const drive: AgentDrive = {
    session,
    sessionId: "",
    env,
    run,
    runJson,
    async launchAgentShell() {
      if (shell) return shell;
      if (!options.launchShell) {
        throw new Error("launchAgentDrivenHunk needs a launchShell factory for on-camera commands");
      }
      shell = await options.launchShell(options.repoDir, env);
      drive.shell = shell;
      await shell.waitForText(/❯/, { timeout: 15_000 });
      await sleep(300);
      return shell;
    },
    close() {
      shell?.close();
      session.close();
    },
  };

  try {
    await session.waitForText(options.readyPattern ?? /src\//, { timeout: 60_000 });
    await ensureKeyboardIsLive(session, options.keyboardProbe);

    // Registration with the daemon is asynchronous — poll instead of racing it.
    let sessionId: string | undefined;
    for (let attempt = 0; attempt < 60 && !sessionId; attempt += 1) {
      try {
        const listed = runJson<{ sessions?: { sessionId: string }[] }>(["list", "--json"]);
        sessionId = listed.sessions?.[0]?.sessionId;
      } catch {
        // The daemon has not answered yet; keep polling.
      }
      if (!sessionId) await sleep(500);
    }
    if (!sessionId) {
      throw new Error(
        `hunk session never registered with the capture daemon on port ${env.HUNK_MCP_PORT}`,
      );
    }
    drive.sessionId = sessionId;
  } catch (error) {
    drive.close();
    throw error;
  }

  return drive;
}

/**
 * Builds a bin dir exposing a real `hunk` command that execs the dev
 * entrypoint, so shell scenes type the shipped command name.
 */
export function createHunkCommandWrapper(binDir: string, hunkEntrypoint: string) {
  return createCommandWrapper(binDir, "hunk", [process.execPath, "run", hunkEntrypoint, "--"]);
}

/** One beat of an agent-driven scene. */
export type AgentGesture =
  | {
      /** Runs a session command off camera, then snaps the TUI reacting to it. */
      kind: "silent";
      args: string[];
      terminalSnap?: string;
      settleMs?: number;
    }
  | {
      /** Types the same kind of command on camera in the driver shell. */
      kind: "shell";
      commandText: string;
      /** Frame names keyed by character index, for the typing animation. */
      typingSnaps?: Record<number, string>;
      /** Shell frame taken once the command has run. */
      shellSnap?: string;
      /** TUI frame taken after the command took effect. */
      terminalSnap?: string;
      /** Shell output proving the command finished, waited on before snapping. */
      expect?: RegExp;
      settleMs?: number;
    };

/**
 * Plays a gesture sequence against one drive, snapping the requested frames.
 *
 * Both gesture kinds run the same session CLI against the same daemon; the
 * only difference is whether the command is typed on camera. Settling is an
 * explicit sleep so playback shows the TUI already reacting in every frame.
 */
export async function driveGestures(
  drive: AgentDrive,
  keyframer: Keyframer,
  gestures: AgentGesture[],
) {
  for (const gesture of gestures) {
    if (gesture.kind === "silent") {
      drive.run(gesture.args);
      await sleep(gesture.settleMs ?? 600);
      if (gesture.terminalSnap) await keyframer.snap(drive.session, gesture.terminalSnap);
      continue;
    }

    const shell = await drive.launchAgentShell();
    await typeCommand(shell, keyframer, gesture.commandText, gesture.typingSnaps ?? {});
    await shell.press("enter");
    if (gesture.expect) await shell.waitForText(gesture.expect, { timeout: 60_000 });
    await sleep(gesture.settleMs ?? 2_500);
    if (gesture.shellSnap) await keyframer.snap(shell, gesture.shellSnap);
    if (gesture.terminalSnap) await keyframer.snap(drive.session, gesture.terminalSnap);
  }
}
