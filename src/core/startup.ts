import { resolveConfiguredCliInput } from "./config";
import { HunkUserError } from "./errors";
import { loadAppBootstrap } from "./loaders";
import { looksLikePatchInput } from "./pager";
import {
  openControllingTerminal,
  resolveRuntimeCliInput,
  usesPipedPatchInput,
  type ControllingTerminal,
} from "./terminal";
import type {
  AppBootstrap,
  CliInput,
  PagerCommandInput,
  ParsedCliInput,
  SessionCommandInput,
} from "./types";
import { canReloadInput } from "./watch";
import { parseCli, renderCliHelp } from "./cli";

export type StartupPlan =
  | {
      kind: "help";
      text: string;
    }
  | {
      kind: "mcp-serve";
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
      kind: "app";
      bootstrap: AppBootstrap;
      cliInput: CliInput;
      controllingTerminal: ControllingTerminal | null;
    };

export interface StartupDeps {
  parseCliImpl?: (argv: string[]) => Promise<ParsedCliInput>;
  readStdinText?: () => Promise<string>;
  looksLikePatchInputImpl?: (text: string) => boolean;
  resolveRuntimeCliInputImpl?: typeof resolveRuntimeCliInput;
  resolveConfiguredCliInputImpl?: typeof resolveConfiguredCliInput;
  loadAppBootstrapImpl?: typeof loadAppBootstrap;
  usesPipedPatchInputImpl?: typeof usesPipedPatchInput;
  openControllingTerminalImpl?: typeof openControllingTerminal;
  stdinIsTTY?: boolean;
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
  const stdinIsTTY = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);

  const parsedCliInput = await parseCliImpl(argv);

  if (parsedCliInput.kind === "help") {
    return {
      kind: "help",
      text: parsedCliInput.text,
    };
  }

  if (parsedCliInput.kind === "mcp-serve") {
    return {
      kind: "mcp-serve",
    };
  }

  if (parsedCliInput.kind === "session") {
    return {
      kind: "session-command",
      input: parsedCliInput,
    };
  }

  const bareInvocation = parsedCliInput.kind === "bare";
  let appCliInput: CliInput | PagerCommandInput;

  if (bareInvocation) {
    // Keep bare `hunk` ergonomic in interactive shells while preserving pager-style stdin flows.
    if (stdinIsTTY) {
      appCliInput = { kind: "git", staged: false, options: {} };
    } else {
      appCliInput = { kind: "pager", options: {} };
    }
  } else if (parsedCliInput.kind === "pager") {
    appCliInput = parsedCliInput;
  } else {
    appCliInput = parsedCliInput;
  }

  if (appCliInput.kind === "pager") {
    const stdinText = await readStdinText();

    if (stdinText.length === 0 && bareInvocation) {
      return {
        kind: "help",
        text: renderCliHelp(),
      };
    }

    if (!looksLikePatchInputImpl(stdinText)) {
      return {
        kind: "plain-text-pager",
        text: stdinText,
      };
    }

    appCliInput = {
      kind: "patch",
      file: "-",
      text: stdinText,
      options: {
        ...appCliInput.options,
        pager: true,
      },
    };
  }

  const runtimeCliInput = resolveRuntimeCliInputImpl(appCliInput);
  const configured = resolveConfiguredCliInputImpl(runtimeCliInput);
  const cliInput = configured.input;

  if (cliInput.options.watch && !canReloadInput(cliInput)) {
    throw new HunkUserError(
      "`--watch` requires a file- or Git-backed input that Hunk can reopen.",
      [
        "Use a patch file path instead of stdin, and avoid `--agent-context -` for watched sessions.",
      ],
    );
  }

  const bootstrap = await loadAppBootstrapImpl(cliInput);
  const controllingTerminal = usesPipedPatchInputImpl(cliInput)
    ? openControllingTerminalImpl()
    : null;

  return {
    kind: "app",
    bootstrap,
    cliInput,
    controllingTerminal,
  };
}
