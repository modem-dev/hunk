import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { parse as parseShellCommand, type ParseEntry } from "shell-quote";
import { stripTerminalControl } from "../patch/sanitize";
import { sanitizeTerminalText } from "../../lib/terminalText";
import { writeStdout } from "./stdout";

/** Detect whether generic pager stdin looks like a diff/patch that Hunk should review. */
export function looksLikePatchInput(text: string) {
  const normalized = stripTerminalControl(text.replaceAll("\r\n", "\n"));

  return (
    /^diff --git /m.test(normalized) ||
    (/^--- /m.test(normalized) && /^\+\+\+ /m.test(normalized)) ||
    /^@@ /m.test(normalized)
  );
}

const DEFAULT_TEXT_PAGER_COMMAND = process.platform === "win32" ? "more" : "less -R";

interface ResolvedPagerCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  displayCommand: string;
}

/** Convert shell-quote parse entries to literal argv tokens without evaluating shell operators. */
function pagerWordFromParseEntry(entry: ParseEntry) {
  if (typeof entry === "string") {
    return entry;
  }

  if ("op" in entry) {
    return entry.op === "glob" ? entry.pattern : entry.op;
  }

  return null;
}

/** Split a pager command into argv words without shell execution or variable expansion. */
function splitPagerCommand(command: string) {
  const preserveVariableReference = (name: string) => `$${name}`;
  return parseShellCommand(command, preserveVariableReference).flatMap((entry) => {
    const word = pagerWordFromParseEntry(entry);
    return word === null ? [] : [word];
  });
}

/** Return a normalized executable name for policy checks across Unix and Windows paths. */
function executableName(command: string) {
  return (
    command
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.(?:cmd|exe)$/i, "")
      .toLowerCase() ?? ""
  );
}

/** Detect simple shell-style `NAME=value` environment assignments before a command. */
function parseEnvAssignment(word: string): [string, string] | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
  return match ? [match[1] ?? "", match[2] ?? ""] : null;
}

/** Return the executable token after supported env-assignment prefixes. */
function resolvePagerSpec(command: string): ResolvedPagerCommand | null {
  const words = splitPagerCommand(command);
  const envOverrides: NodeJS.ProcessEnv = {};
  let commandIndex = 0;

  while (commandIndex < words.length) {
    const word = words[commandIndex];
    const assignment = word ? parseEnvAssignment(word) : null;
    if (!assignment) {
      break;
    }
    const [key, value] = assignment;
    envOverrides[key] = value;
    commandIndex += 1;
  }

  // Support the common `env NAME=value pager ...` wrapper without invoking a shell.
  if (executableName(words[commandIndex] ?? "") === "env") {
    let envIndex = commandIndex + 1;
    const wrappedEnv: NodeJS.ProcessEnv = {};

    while (envIndex < words.length) {
      const word = words[envIndex];
      const assignment = word ? parseEnvAssignment(word) : null;
      if (!assignment) {
        break;
      }
      const [key, value] = assignment;
      wrappedEnv[key] = value;
      envIndex += 1;
    }

    if (envIndex < words.length) {
      commandIndex = envIndex;
      Object.assign(envOverrides, wrappedEnv);
    }
  }

  const executable = words[commandIndex];
  if (!executable) {
    return null;
  }

  return {
    command: executable,
    args: words.slice(commandIndex + 1),
    env: envOverrides,
    displayCommand: command,
  };
}

/** Choose a plain-text pager process while avoiding recursive `hunk pager` launches. */
function resolveTextPagerSpec(env: NodeJS.ProcessEnv = process.env): ResolvedPagerCommand {
  const candidate = env.HUNK_TEXT_PAGER ?? env.PAGER;
  const pagerSpec = candidate ? resolvePagerSpec(candidate) : null;

  if (!pagerSpec || executableName(pagerSpec.command) === "hunk") {
    const fallbackSpec = resolvePagerSpec(DEFAULT_TEXT_PAGER_COMMAND);
    if (!fallbackSpec) {
      throw new Error(`Default pager command is invalid: ${DEFAULT_TEXT_PAGER_COMMAND}`);
    }
    return fallbackSpec;
  }

  return pagerSpec;
}

/** Choose a plain-text pager command while avoiding recursive `hunk pager` launches. */
export function resolveTextPagerCommand(env: NodeJS.ProcessEnv = process.env): string {
  return resolveTextPagerSpec(env).displayCommand;
}

/** Minimal dependencies for testing pager behavior without spawning a real subprocess. */
export interface PlainTextPagerDeps {
  stdout: Pick<NodeJS.WriteStream, "isTTY" | "write">;
  spawnImpl: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export interface PlainTextPagerWriter {
  /** Return false when the pager closed early and the producer should stop reading. */
  write(text: string): Promise<boolean | void>;
  close(): Promise<void>;
}

/** Open one pager writer so callers can stream bounded chunks after deciding output will overflow. */
export function openPlainTextPager(
  env: NodeJS.ProcessEnv = process.env,
  deps: PlainTextPagerDeps = {
    // Write through the descriptor rather than `process.stdout`: a piped consumer takes one
    // buffer at a time, and the caller exits as soon as this returns.
    stdout: {
      isTTY: process.stdout.isTTY,
      write: (chunk) => {
        writeStdout(String(chunk));
        return true;
      },
    },
    spawnImpl: spawn,
  },
): PlainTextPagerWriter {
  if (!deps.stdout.isTTY) {
    return {
      async write(text) {
        deps.stdout.write(sanitizeTerminalText(text));
      },
      async close() {},
    };
  }

  const pagerSpec = resolveTextPagerSpec(env);
  const pagerCommand = pagerSpec.displayCommand;
  let pager: ChildProcess;
  try {
    pager = deps.spawnImpl(pagerSpec.command, pagerSpec.args, {
      shell: false,
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...env, ...pagerSpec.env },
    });
  } catch (error) {
    throw new Error(`Pager command failed: ${pagerCommand}`, { cause: error });
  }

  let spawnError: unknown;
  let stdinError: NodeJS.ErrnoException | undefined;
  let closed = false;
  let pagerExited = false;
  const closeCode = new Promise<number | null>((resolve) => {
    pager.once("error", (error) => {
      spawnError = error;
    });
    pager.once("close", (code) => {
      pagerExited = true;
      resolve(typeof code === "number" ? code : null);
    });
  });
  pager.stdin?.once("error", (error: NodeJS.ErrnoException) => {
    stdinError = error;
  });

  return {
    async write(text) {
      if (closed || pagerExited || stdinError?.code === "EPIPE") return false;
      const safeText = sanitizeTerminalText(text, { preserveAnsiStyle: true });
      if (!pager.stdin?.write(safeText)) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            pager.stdin?.off("drain", finish);
            pager.stdin?.off("error", finish);
            pager.off("close", finish);
            resolve();
          };
          pager.stdin?.once("drain", finish);
          pager.stdin?.once("error", finish);
          pager.once("close", finish);
        });
      }
      return !pagerExited && stdinError?.code !== "EPIPE";
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!pager.stdin?.destroyed) pager.stdin?.end();
      const code = await closeCode;
      const normalEarlyQuit = stdinError?.code === "EPIPE" && code === 0;
      if (
        spawnError ||
        (stdinError && !normalEarlyQuit) ||
        (typeof code === "number" && code !== 0)
      ) {
        throw new Error(`Pager command failed: ${pagerCommand}`, {
          cause: spawnError ?? stdinError,
        });
      }
    },
  };
}

/** Stream plain text through a normal pager, or write directly when not attached to a terminal. */
export async function pagePlainText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: PlainTextPagerDeps = { stdout: process.stdout, spawnImpl: spawn },
) {
  if (!deps.stdout.isTTY) {
    deps.stdout.write(sanitizeTerminalText(text));
    return;
  }
  const pager = openPlainTextPager(env, deps);
  await pager.write(text);
  await pager.close();
}
