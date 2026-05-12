import { resolveConfiguredCliInput } from "./config";
import { HunkUserError } from "./errors";
import { loadAppBootstrap } from "./loaders";
import { looksLikePatchInput } from "./pager";
import { detectTerminalThemeModeFromBackground } from "./themeDetection";
import {
  openControllingTerminal,
  resolveRuntimeCliInput,
  usesPipedPatchInput,
  type ControllingTerminal,
} from "./terminal";
import type { AppBootstrap, CliInput, ParsedCliInput, SessionCommandInput } from "./types";
import { canReloadInput } from "./watch";
import { parseCli } from "./cli";

export type StartupPlan =
  | {
      kind: "help";
      text: string;
    }
  | {
      kind: "daemon-serve";
    }
  | {
      kind: "session-command";
      input: SessionCommandInput;
    }
  | {
      kind: "plain-text-pager";
      text: string;
    }
  | {
      kind: "passthrough";
      text: string;
    }
  | {
      kind: "static-diff-pager";
      text: string;
      options: CliInput["options"];
    }
  | {
      kind: "app";
      bootstrap: AppBootstrap;
      cliInput: CliInput;
      controllingTerminal: ControllingTerminal | null;
    };

function isCapturedPagerHost(env: NodeJS.ProcessEnv) {
  return (
    env.TERM === "dumb" &&
    (env.LV === "-c" ||
      Boolean(env.GIT_PAGER) ||
      Object.keys(env).some((key) => key.startsWith("LAZYGIT")))
  );
}

export interface StartupDeps {
  parseCliImpl?: (argv: string[]) => Promise<ParsedCliInput>;
  readStdinText?: () => Promise<string>;
  looksLikePatchInputImpl?: (text: string) => boolean;
  resolveRuntimeCliInputImpl?: typeof resolveRuntimeCliInput;
  resolveConfiguredCliInputImpl?: typeof resolveConfiguredCliInput;
  loadAppBootstrapImpl?: typeof loadAppBootstrap;
  usesPipedPatchInputImpl?: typeof usesPipedPatchInput;
  openControllingTerminalImpl?: typeof openControllingTerminal;
  detectTerminalThemeModeFromBackgroundImpl?: typeof detectTerminalThemeModeFromBackground;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  stdout?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
}

/** Normalize startup work so help, pager, and app-bootstrap paths can be tested directly. */
export async function prepareStartupPlan(
  argv: string[] = process.argv,
  deps: StartupDeps = {},
): Promise<StartupPlan> {
  const parseCliImpl = deps.parseCliImpl ?? parseCli;
  const readStdinText = deps.readStdinText ?? (() => new Response(Bun.stdin.stream()).text());
  const looksLikePatchInputImpl = deps.looksLikePatchInputImpl ?? looksLikePatchInput;
  const resolveRuntimeCliInputImpl = deps.resolveRuntimeCliInputImpl ?? resolveRuntimeCliInput;
  const resolveConfiguredCliInputImpl =
    deps.resolveConfiguredCliInputImpl ?? resolveConfiguredCliInput;
  const loadAppBootstrapImpl = deps.loadAppBootstrapImpl ?? loadAppBootstrap;
  const usesPipedPatchInputImpl = deps.usesPipedPatchInputImpl ?? usesPipedPatchInput;
  const openControllingTerminalImpl = deps.openControllingTerminalImpl ?? openControllingTerminal;
  const detectTerminalThemeModeFromBackgroundImpl =
    deps.detectTerminalThemeModeFromBackgroundImpl ?? detectTerminalThemeModeFromBackground;
  const stdinIsTTY = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = deps.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const stdout = deps.stdout ?? process.stdout;
  const env = deps.env ?? process.env;

  let parsedCliInput = await parseCliImpl(argv);
  let controllingTerminal: ControllingTerminal | null = null;

  if (parsedCliInput.kind === "help") {
    return {
      kind: "help",
      text: parsedCliInput.text,
    };
  }

  if (parsedCliInput.kind === "daemon-serve") {
    return {
      kind: "daemon-serve",
    };
  }

  if (parsedCliInput.kind === "session") {
    return {
      kind: "session-command",
      input: parsedCliInput,
    };
  }

  if (parsedCliInput.kind === "pager") {
    const stdinText = await readStdinText();
    const pagerOptions = parsedCliInput.options;
    const staticPagerPlan = () => {
      const staticPatchInput: CliInput = {
        kind: "patch",
        file: "-",
        text: stdinText,
        options: {
          ...pagerOptions,
          pager: true,
        },
      };
      const configuredStaticInput = resolveConfiguredCliInputImpl(
        resolveRuntimeCliInputImpl(staticPatchInput),
      ).input;

      return {
        kind: "static-diff-pager" as const,
        text: stdinText,
        options: configuredStaticInput.options,
      };
    };

    if (!looksLikePatchInputImpl(stdinText)) {
      return {
        kind: "plain-text-pager",
        text: stdinText,
      };
    }

    if (!stdoutIsTTY) {
      return {
        kind: "passthrough",
        text: stdinText,
      };
    }

    if (env.TERM === "dumb" && !isCapturedPagerHost(env)) {
      return {
        kind: "passthrough",
        text: stdinText,
      };
    }

    // Captured pager hosts like LazyGit can provide a PTY while advertising TERM=dumb.
    // In that mode, emit static colored diff output instead of launching the TUI.
    if (isCapturedPagerHost(env)) {
      return staticPagerPlan();
    }

    controllingTerminal = openControllingTerminalImpl();
    if (!controllingTerminal) {
      return staticPagerPlan();
    }

    parsedCliInput = {
      kind: "patch",
      file: "-",
      text: stdinText,
      options: {
        ...parsedCliInput.options,
        pager: true,
      },
    };
  }

  const runtimeCliInput = resolveRuntimeCliInputImpl(parsedCliInput);
  const configured = resolveConfiguredCliInputImpl(runtimeCliInput);
  const cliInput = configured.input;

  // Any app session launched with piped stdin still needs a real terminal input stream for
  // keyboard, mouse, and terminal query responses. Auto-theme happened to open this path during
  // probing; make it unconditional so concrete themes behave the same way.
  if (!controllingTerminal && !stdinIsTTY && stdoutIsTTY) {
    controllingTerminal = openControllingTerminalImpl();
  }

  let initialThemeMode: AppBootstrap["initialThemeMode"];
  if (cliInput.options.theme === "auto" && stdoutIsTTY) {
    const themeInput = controllingTerminal?.stdin ?? (stdinIsTTY ? process.stdin : null);
    if (themeInput) {
      initialThemeMode =
        (await detectTerminalThemeModeFromBackgroundImpl({ input: themeInput, output: stdout })) ??
        undefined;
    }
  }

  if (cliInput.options.watch && !canReloadInput(cliInput)) {
    throw new HunkUserError(
      "`--watch` requires a file- or Git-backed input that Hunk can reopen.",
      [
        "Use a patch file path instead of stdin, and avoid `--agent-context -` for watched sessions.",
      ],
    );
  }

  let bootstrap: AppBootstrap;
  try {
    bootstrap = await loadAppBootstrapImpl(cliInput, { customTheme: configured.customTheme });
  } catch (error) {
    controllingTerminal?.close();
    throw error;
  }

  bootstrap.initialThemeMode = initialThemeMode ?? bootstrap.initialThemeMode;

  controllingTerminal ??= usesPipedPatchInputImpl(cliInput) ? openControllingTerminalImpl() : null;

  return {
    kind: "app",
    bootstrap,
    cliInput,
    controllingTerminal,
  };
}
