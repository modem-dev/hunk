import {
  applyExtensionChangesetTransforms,
  applyExtensionRegistrations,
  createExtensionApplyNotices,
  createUnknownVcsNotice,
  resolveDetectedVcsIdWithExtensions,
  resolveSessionVcsId,
} from "../extensions/apply";
import { loadBundledExtensions } from "../extensions/bundled";
import {
  createExtensionLoadNotices,
  loadStartupExtensions,
  mergeStartupNotices,
} from "../extensions/startup";
import { resolveConfiguredCliInput } from "./config";
import { collectSessionCustomThemes } from "./customThemes";
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
import type {
  AppBootstrap,
  CliInput,
  MarkupRenderCommandInput,
  ParsedCliInput,
  SessionCommandInput,
} from "./types";
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
      customThemes?: AppBootstrap["customThemes"];
    }
  | {
      kind: "markup-render";
      input: MarkupRenderCommandInput;
    }
  | {
      kind: "markup-guide";
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
  loadStartupExtensionsImpl?: typeof loadStartupExtensions;
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
  const loadStartupExtensionsImpl = deps.loadStartupExtensionsImpl ?? loadStartupExtensions;
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

  if (parsedCliInput.kind === "markup-render") {
    return {
      kind: "markup-render",
      input: parsedCliInput,
    };
  }

  if (parsedCliInput.kind === "markup-guide") {
    return {
      kind: "markup-guide",
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
      const configuredStatic = resolveConfiguredCliInputImpl(
        resolveRuntimeCliInputImpl(staticPatchInput),
      );
      const staticPlan = {
        kind: "static-diff-pager" as const,
        text: stdinText,
        options: configuredStatic.input.options,
      };

      // Extensions never load on the static pager path, so config themes are the whole set here.
      return configuredStatic.customThemes.length > 0
        ? { ...staticPlan, customThemes: configuredStatic.customThemes }
        : staticPlan;
    };

    if (!looksLikePatchInputImpl(stdinText)) {
      // Dumb-terminal and captured pager hosts cannot safely own an interactive text pager.
      if (env.TERM === "dumb") {
        return {
          kind: "passthrough",
          text: stdinText,
        };
      }

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
  // Reassigned once below if an extension VCS backend claims this checkout.
  let cliInput = configured.input;

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

  // Extensions load before the changeset so later stages can hand their VCS adapters and
  // changeset transforms to the loading pipeline. Failures never reach here: the host
  // isolates them into issues that become startup notices below.
  const startupCwd = process.cwd();
  const extensionResult = await loadStartupExtensionsImpl({
    extensions: configured.extensions,
    cwd: startupCwd,
    env,
    cliExtensionPaths: cliInput.options.extensionPaths,
  });

  // Extension themes join the config-defined ones here, so the rest of the app sees one
  // ordered theme list instead of two sources it would have to reconcile itself.
  const sessionThemes = collectSessionCustomThemes(
    configured.customThemes,
    extensionResult.registry.themes,
  );

  // File languages register globally; VCS adapters are threaded into loading below.
  const applied = applyExtensionRegistrations(extensionResult);
  // Config accepts any `vcs` id because it resolves before extensions load. Settle
  // that choice now: honor it when a loaded backend owns it, otherwise fall back
  // to detection and tell the user, instead of dropping it in silence.
  const sessionVcs = resolveSessionVcsId(cliInput.options.vcs, startupCwd, applied.vcsAdapters);
  if (sessionVcs.vcsId !== cliInput.options.vcs) {
    cliInput = { ...cliInput, options: { ...cliInput.options, vcs: sessionVcs.vcsId } };
  }

  // Config detected the checkout before extension backends existed, so detection
  // runs again over the full adapter list: the nearest checkout wins whoever
  // registered it. An explicit `vcs` this session owns is left alone.
  const detectedVcsId = resolveDetectedVcsIdWithExtensions(
    startupCwd,
    applied.vcsAdapters,
    configured.explicitVcsId,
  );
  if (detectedVcsId !== undefined && detectedVcsId !== cliInput.options.vcs) {
    cliInput = { ...cliInput, options: { ...cliInput.options, vcs: detectedVcsId } };
  }

  // Built after both steps so the notice names the backend the session really
  // loads with, not the intermediate fallback detection first proposed.
  const unknownVcsNotices =
    sessionVcs.unknownVcsId !== undefined
      ? [createUnknownVcsNotice(sessionVcs.unknownVcsId, String(cliInput.options.vcs))]
      : [];

  let bootstrap: AppBootstrap;
  try {
    bootstrap = await loadAppBootstrapImpl(cliInput, {
      customThemes: sessionThemes.themes,
      vcsAdapters: applied.vcsAdapters,
    });
  } catch (error) {
    controllingTerminal?.close();
    throw error;
  }

  // Transforms run on the loaded changeset so the sidebar and review stream both
  // follow whatever the extensions produced, with no separate pre-transform copy.
  bootstrap.changeset = await applyExtensionChangesetTransforms(
    extensionResult,
    bootstrap.changeset,
  );

  // Bundled extensions load with the VCS adapters, well before this point, so a
  // failure there is reported here rather than lost. It should be unreachable —
  // these factories are Hunk's own — but the isolation contract is the contract.
  const bundledNotices = createExtensionLoadNotices(loadBundledExtensions().issues);

  bootstrap.initialThemeMode = initialThemeMode ?? bootstrap.initialThemeMode;
  bootstrap.startupNotices = mergeStartupNotices(
    // Keep the resolved array identity when extensions contributed no theme notices.
    sessionThemes.notices.length > 0 ||
      applied.issues.length > 0 ||
      bundledNotices.length > 0 ||
      unknownVcsNotices.length > 0
      ? [
          ...(configured.startupNotices ?? []),
          ...sessionThemes.notices,
          ...createExtensionApplyNotices(applied.issues),
          ...bundledNotices,
          ...unknownVcsNotices,
        ]
      : configured.startupNotices,
    extensionResult,
  );
  bootstrap.viewPreferencesConfigPath = configured.viewPreferencesConfigPath;
  bootstrap.extensions = extensionResult;

  controllingTerminal ??= usesPipedPatchInputImpl(cliInput) ? openControllingTerminalImpl() : null;

  return {
    kind: "app",
    bootstrap,
    cliInput,
    controllingTerminal,
  };
}
