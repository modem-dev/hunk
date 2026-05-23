import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { stripTerminalControl } from "./patch/normalize";

/** Detect whether generic pager stdin looks like a diff/patch that Hunk should review. */
export function looksLikePatchInput(text: string) {
  const normalized = stripTerminalControl(text.replaceAll("\r\n", "\n"));

  return (
    /^diff --git /m.test(normalized) ||
    (/^--- /m.test(normalized) && /^\+\+\+ /m.test(normalized)) ||
    /^@@ /m.test(normalized)
  );
}

/** Choose a plain-text pager command while avoiding recursive `hunk pager` launches. */
export function resolveTextPagerCommand(env: NodeJS.ProcessEnv = process.env) {
  const candidate = env.HUNK_TEXT_PAGER ?? env.PAGER;

  if (!candidate || /(^|\s)hunk(\s|$)/.test(candidate)) {
    return "less -R";
  }

  return candidate;
}

function parsePagerCommand(command: string): [string, string[]] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (inQuotes) {
      if (char === quoteChar) {
        inQuotes = false;
        quoteChar = "";
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuotes = true;
      quoteChar = char;
    } else if (char === " " || char === "\t") {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current.length > 0) {
    args.push(current);
  }

  const [executable, ...rest] = args;
  return [executable ?? "", rest];
}

/** Minimal dependencies for testing pager behavior without spawning a real subprocess. */
export interface PlainTextPagerDeps {
  stdout: Pick<NodeJS.WriteStream, "isTTY" | "write">;
  spawnImpl: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/** Stream plain text through a normal pager, or write directly when not attached to a terminal. */
export async function pagePlainText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: PlainTextPagerDeps = {
    stdout: process.stdout,
    spawnImpl: spawn,
  },
) {
  if (!deps.stdout.isTTY) {
    deps.stdout.write(text);
    return;
  }

  const pagerCommand = resolveTextPagerCommand(env);
  const [executable, args] = parsePagerCommand(pagerCommand);
  const pager = deps.spawnImpl(executable, args, {
    shell: false,
    stdio: ["pipe", "inherit", "inherit"],
    env,
  });

  pager.stdin?.end(text);
  const [code] = await once(pager, "close");

  if (typeof code === "number" && code !== 0) {
    throw new Error(`Pager command failed: ${pagerCommand}`);
  }
}
