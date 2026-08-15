import type { SessionBootstrapResult } from "./sessionBootstrap";
import { createExtensionApplyNotices, createUnknownVcsNotice } from "../extensions/apply";
import type { loadStartupExtensions } from "../extensions/startup";
import { resolveConfiguredCliInput } from "../core/config";
import { HunkUserError } from "../core/errors";
import type { loadAppBootstrap } from "../core/changesetLoaders";
import { looksLikePatchInput } from "../core/pager";
import { detectTerminalThemeModeFromBackground } from "../core/theme/detection";
import {
  openControllingTerminal,
  resolveRuntimeCliInput,
  usesPipedPatchInput,
  type ControllingTerminal,
} from "../core/terminal";
import type { AppBootstrap } from "./types";
import type {
  CliInput,
  ExtensionManageCommandInput,
  MarkupRenderCommandInput,
  ParsedCliInput,
  SessionCommandInput,
} from "../core/types";
import { canReloadInput } from "../core/inputReload";
import { parseCli } from "../core/cli";
import { resolveSessionSelectorBoundary } from "./sessionSelector";
import type { VcsCatalog } from "../core/vcs/types";

/**
 * Load the bundled VCS catalog, memoized per call to `prepareStartupPlan`.
 *
 * The catalog reaches the VCS adapters, which reach changeset construction and from there the
 * diff engine and its syntax grammars. `--version`, `--help`, `daemon serve`, and the markup
 * and extension-management commands all answer without it, so it is resolved on demand rather
 * than at module load; every command paid for it otherwise.
 */
function createBundledVcsCatalogLoader() {
  let cached: VcsCatalog | undefined;
  return async () => {
    cached ??= (await import("./vcsCatalog")).getBundledVcsCatalog();
    return cached;
  };
}

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
      preserveColor: boolean;
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
      kind: "extension-manage";
      input: ExtensionManageCommandInput;
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
  const usesPipedPatchInputImpl = deps.usesPipedPatchInputImpl ?? usesPipedPatchInput;
  const openControllingTerminalImpl = deps.openControllingTerminalImpl ?? openControllingTerminal;
  const detectTerminalThemeModeFromBackgroundImpl =
    deps.detectTerminalThemeModeFromBackgroundImpl ?? detectTerminalThemeModeFromBackground;
  const stdinIsTTY = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = deps.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const stdout = deps.stdout ?? process.stdout;
  const env = deps.env ?? process.env;
  const loadBaseVcsCatalog = createBundledVcsCatalogLoader();

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
    const sessionInput =
      "selector" in parsedCliInput
        ? {
            ...parsedCliInput,
            selector: resolveSessionSelectorBoundary(
              parsedCliInput.selector,
              await loadBaseVcsCatalog(),
            ),
          }
        : parsedCliInput;
    return {
      kind: "session-command",
      input: sessionInput,
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

  if (parsedCliInput.kind === "extension-manage") {
    return {
      kind: "extension-manage",
      input: parsedCliInput,
    };
  }

  if (parsedCliInput.kind === "pager") {
    const stdinText = await readStdinText();
    const pagerOptions = parsedCliInput.options;
    const capturedPagerHost = isCapturedPagerHost(env);
    const staticPagerPlan = async () => {
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
        {
          vcsCatalog: await loadBaseVcsCatalog(),
        },
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

    // Captured hosts render Hunk's stdout in their own panel, so passed-through text keeps
    // the color Git already put in it.
    const passthroughPlan = {
      kind: "passthrough" as const,
      text: stdinText,
      preserveColor: capturedPagerHost,
    };

    if (!looksLikePatchInputImpl(stdinText)) {
      // Dumb-terminal and captured pager hosts cannot safely own an interactive text pager.
      if (env.TERM === "dumb") {
        return passthroughPlan;
      }

      return {
        kind: "plain-text-pager",
        text: stdinText,
      };
    }

    if (!stdoutIsTTY) {
      return passthroughPlan;
    }

    if (env.TERM === "dumb" && !capturedPagerHost) {
      return passthroughPlan;
    }

    // Captured pager hosts like LazyGit can provide a PTY while advertising TERM=dumb.
    // In that mode, emit static colored diff output instead of launching the TUI.
    if (capturedPagerHost) {
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
  const startupCwd = process.cwd();
  // Past this point the plan always builds a changeset, so the catalog and the loading pipeline
  // are needed for certain; resolve them together rather than at each use.
  const baseVcsCatalog = await loadBaseVcsCatalog();
  let configured = resolveConfiguredCliInputImpl(runtimeCliInput, {
    cwd: startupCwd,
    env,
    vcsCatalog: baseVcsCatalog,
  });
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
  // changeset transforms to the loading pipeline. External adapters may settle a root the
  // bundled catalog could not; the shared resolver then appends newly discovered repo
  // candidates without executing the provisional factory prefix twice.
  const [{ resolveConfiguredExtensions }, { loadConfiguredSessionBootstrap }, startupExtensions] =
    await Promise.all([
      import("./extensionBootstrap"),
      import("./sessionBootstrap"),
      import("../extensions/startup"),
    ]);
  const loadAppBootstrapImpl =
    deps.loadAppBootstrapImpl ?? (await import("../core/changesetLoaders")).loadAppBootstrap;
  const loadStartupExtensionsImpl =
    deps.loadStartupExtensionsImpl ?? startupExtensions.loadStartupExtensions;

  const resolvedExtensions = await resolveConfiguredExtensions(
    {
      runtimeInput: runtimeCliInput,
      configured,
      cwd: startupCwd,
      env,
      baseVcsCatalog,
    },
    { resolveConfiguredCliInputImpl, loadStartupExtensionsImpl },
  );
  configured = resolvedExtensions.configured;
  cliInput = configured.input;
  const extensionResult = resolvedExtensions.extensions;

  let preparedSession: SessionBootstrapResult;
  try {
    preparedSession = await loadConfiguredSessionBootstrap({
      configured,
      cwd: startupCwd,
      extensions: extensionResult,
      initialThemeMode,
      loadAppBootstrapImpl,
      baseVcsCatalog,
    });
  } catch (error) {
    controllingTerminal?.close();
    throw error;
  }
  const { applied, bootstrap, input: resolvedInput, sessionThemes, sessionVcs } = preparedSession;
  cliInput = resolvedInput;

  // Built after adapter resolution so the notice names the backend the session really loads with.
  const unknownVcsNotices =
    sessionVcs.unknownVcsId !== undefined
      ? [createUnknownVcsNotice(sessionVcs.unknownVcsId, String(cliInput.options.vcs))]
      : [];

  // Bundled extensions load with the VCS adapters, well before this point, so a
  // failure there is reported here rather than lost. It should be unreachable —
  // these factories are Hunk's own — but the isolation contract is the contract.
  const { loadBundledExtensions } = await import("../extensions/default/vcs");
  const bundledNotices = startupExtensions.createExtensionLoadNotices(
    loadBundledExtensions().issues,
  );

  bootstrap.startupNotices = startupExtensions.mergeStartupNotices(
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
  controllingTerminal ??= usesPipedPatchInputImpl(cliInput) ? openControllingTerminalImpl() : null;

  return {
    kind: "app",
    bootstrap,
    cliInput,
    controllingTerminal,
  };
}
