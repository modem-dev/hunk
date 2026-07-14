import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface SanitizedGitCommand {
  timestamp: string;
  family: string;
  arguments: string[];
}

export interface GitTraceActivity {
  instrumentationMode: "git-trace2-event";
  separateFromHeadlineMetrics: true;
  tracePath: string;
  durationMs: number;
  totalInvocations: number;
  groups: Record<string, number>;
  commands: SanitizedGitCommand[];
  malformedLineCount: number;
  childCpuMs: null;
  childCpuStatus: "not-available";
}

const OPTIONS_WITH_VALUES = new Set([
  "-c",
  "-C",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

/** Reduce one Git argv to command family plus flags without retaining host paths or URLs. */
export function sanitizeGitArgv(argv: unknown): { family: string; arguments: string[] } {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new Error("Trace2 start argv must be a string array");
  }
  const args = [...(argv as string[])];
  if (args[0] && /(^|[\\/])git(?:\.exe)?$/i.test(args[0])) args.shift();

  let family = "other";
  let familyIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (OPTIONS_WITH_VALUES.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    family = /^[a-z0-9-]+$/i.test(argument) ? argument.toLowerCase() : "other";
    familyIndex = index;
    break;
  }

  const normalized: string[] = [];
  let pathspecMode = false;
  for (const argument of args.slice(familyIndex + 1)) {
    if (argument === "--") {
      normalized.push("--");
      pathspecMode = true;
    } else if (pathspecMode) {
      normalized.push("<pathspec>");
    } else if (argument.startsWith("-")) {
      normalized.push(
        argument.includes("=") ? `${argument.slice(0, argument.indexOf("="))}=<value>` : argument,
      );
    } else if (/^(?:HEAD|FETCH_HEAD|ORIG_HEAD|[a-f0-9]{7,64})(?:[~^].*)?$/i.test(argument)) {
      normalized.push("<revision>");
    } else {
      normalized.push("<value>");
    }
  }
  return { family, arguments: normalized };
}

/** Parse raw Trace2 JSONL and retain only sanitized top-level Git start records. */
export function parseGitTrace2(text: string): {
  commands: SanitizedGitCommand[];
  malformedLineCount: number;
} {
  const commands: SanitizedGitCommand[] = [];
  let malformedLineCount = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      malformedLineCount += 1;
      continue;
    }
    if (!event || typeof event !== "object" || (event as { event?: unknown }).event !== "start") {
      continue;
    }
    const timestamp = (event as { time?: unknown }).time;
    const argv = (event as { argv?: unknown }).argv;
    try {
      if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
        throw new Error("Trace2 start event has no timestamp");
      }
      commands.push({ timestamp: new Date(timestamp).toISOString(), ...sanitizeGitArgv(argv) });
    } catch {
      malformedLineCount += 1;
    }
  }
  return { commands, malformedLineCount };
}

/** Prepare a low-distortion Trace2 file inherited by every Git subprocess. */
export function createGitTrace2Environment(rawTracePath: string): {
  rawTracePath: string;
  env: Record<string, string>;
} {
  const absolutePath = resolve(rawTracePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  rmSync(absolutePath, { force: true });
  return {
    rawTracePath: absolutePath,
    env: {
      GIT_TRACE2_EVENT: absolutePath,
      GIT_TRACE2_EVENT_NESTING: "10",
    },
  };
}

/** Sanitize and aggregate one activity run, then remove its path-bearing raw trace. */
export function finalizeGitTrace2Activity(options: {
  rawTracePath: string;
  sanitizedLogPath: string;
  durationMs: number;
}): GitTraceActivity {
  const text = readFileSync(options.rawTracePath, "utf8");
  const parsed = parseGitTrace2(text);
  const groups: Record<string, number> = {};
  for (const command of parsed.commands) groups[command.family] = (groups[command.family] ?? 0) + 1;
  mkdirSync(dirname(options.sanitizedLogPath), { recursive: true });
  writeFileSync(
    options.sanitizedLogPath,
    parsed.commands.map((command) => JSON.stringify(command)).join("\n") +
      (parsed.commands.length ? "\n" : ""),
  );
  rmSync(options.rawTracePath, { force: true });
  return {
    instrumentationMode: "git-trace2-event",
    separateFromHeadlineMetrics: true,
    tracePath: options.sanitizedLogPath,
    durationMs: options.durationMs,
    totalInvocations: parsed.commands.length,
    groups,
    commands: parsed.commands,
    malformedLineCount: parsed.malformedLineCount,
    childCpuMs: null,
    childCpuStatus: "not-available",
  };
}
