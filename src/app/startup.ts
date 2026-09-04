import type { SessionBootstrapResult } from "./sessionBootstrap";
import { createExtensionApplyNotices, createUnknownVcsNotice } from "../extensions/apply";
import type { loadStartupExtensions } from "../extensions/startup";
import { resolveConfiguredCliInput } from "../core/run/config";
import { HunkUserError } from "../core/run/errors";
import type { loadAppBootstrap } from "../core/changeset/loaders";
import { looksLikePatchInput } from "../core/process/pager";
import { sanitizeTerminalText } from "../lib/terminalText";
import { detectTerminalThemeModeFromBackground } from "../core/theme/detection";
import {
  openControllingTerminal,
  resolveRuntimeCliInput,
  usesPipedPatchInput,
  type ControllingTerminal,
} from "../core/process/terminal";
import type { AppBootstrap } from "./types";
import type {
  CliInput,
  ExtensionCliInvocationInput,
  ExtensionManageCommandInput,
  HistoryCommandInput,
  MarkupRenderCommandInput,
  ParsedCliInput,
  SelfUpdateCommandInput,
  SessionCommandInput,
} from "../core/run/commandInputs";
import { canReloadInput } from "../core/run/inputReload";
import { assertReliableWatchRuntime } from "../core/watch/runtime";
import { parseCli } from "./cli";
import { resolveSessionSelectorBoundary } from "./sessionSelector";
import type { VcsCatalog } from "../core/vcs/types";
import type { ExtensionReviewDescriptor } from "../extension-api/types";

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
      kind: "history-static" | "history-interactive";
      bootstrap: import("./historyBootstrap").HistoryBootstrap;
      input: HistoryCommandInput;
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
      kind: "self-update";
      input: SelfUpdateCommandInput;
    }
  | {
      kind: "extension-cli-exit";
      exitCode: number;
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
  stderr?: NodeJS.WriteStream;
  extensionCliStdin?: AsyncIterable<string | Uint8Array>;
  extensionCliSignals?: import("../extensions/cliCommandRuntime").ExtensionCliSignalSource;
  resolveExtensionCliBootstrapImpl?: typeof import("./extensionCliBootstrap").resolveExtensionCliBootstrap;
  runExtensionCliCommandImpl?: typeof import("../extensions/cliCommandRuntime").runExtensionCliCommand;
  env?: NodeJS.ProcessEnv;
  bunVersion?: string;
}

/** Carry the invocation's authoritative extension paths into a delegated review input. */
function applyDelegatedExtensionFlags(
  input: ParsedCliInput,
  invocation: ExtensionCliInvocationInput,
): ParsedCliInput {
  if (input.kind === "history") {
    return {
      ...input,
      extensionsEnabled: invocation.extensionsEnabled,
      extensionPaths: [...invocation.extensionPaths],
    };
  }
  if (!("options" in input)) return input;
  return {
    ...input,
    options: {
      ...input.options,
      extensions: invocation.extensionsEnabled,
      extensionPaths:
        invocation.extensionPaths.length > 0 ? [...invocation.extensionPaths] : undefined,
    },
  } as ParsedCliInput;
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
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const bunVersion = deps.bunVersion ?? Bun.version;
  const loadBaseVcsCatalog = createBundledVcsCatalogLoader();
  const startupCwd = process.cwd();

  let parsedCliInput = await parseCliImpl(argv);
  let controllingTerminal: ControllingTerminal | null = null;
  let preloadedExtensions: import("../extensions/types").ExtensionLoadResult | undefined;
  let delegatedDiscoveryCatalog: VcsCatalog | undefined;
  let delegatedReview: ExtensionReviewDescriptor | undefined;

  /** Retire startup-owned extension state before returning a non-app plan. */
  const retirePreloadedExtensions = async () => {
    if (!preloadedExtensions) return;
    await (await import("../extensions/events")).retireExtensionLoadResult(preloadedExtensions);
    preloadedExtensions = undefined;
  };
  const finishHeadlessPlan = async <Plan extends StartupPlan>(plan: Plan): Promise<Plan> => {
    await retirePreloadedExtensions();
    return plan;
  };
  async function whileStartupOwnsExtensions<Value>(
    operation: () => Value | Promise<Value>,
  ): Promise<Value> {
    try {
      return await operation();
    } catch (error) {
      await retirePreloadedExtensions();
      throw error;
    }
  }

  if (parsedCliInput.kind === "extension-cli") {
    const invocation = parsedCliInput;
    if (!invocation.extensionsEnabled) {
      throw new Error(`Unknown command: ${invocation.commandName}`);
    }
    const baseVcsCatalog = await loadBaseVcsCatalog();
    const resolveExtensionCliBootstrapImpl =
      deps.resolveExtensionCliBootstrapImpl ??
      (await import("./extensionCliBootstrap")).resolveExtensionCliBootstrap;
    const runExtensionCliCommandImpl =
      deps.runExtensionCliCommandImpl ??
      (await import("../extensions/cliCommandRuntime")).runExtensionCliCommand;
    const resolved = await resolveExtensionCliBootstrapImpl({
      input: invocation,
      cwd: startupCwd,
      env,
      baseVcsCatalog,
    });
    preloadedExtensions = resolved.extensions;

    try {
      const registered = resolved.commands.commands.get(invocation.commandName);
      if (!registered) {
        const suggestions: string[] = [];
        // The registry is already loaded, so name what the loaded extensions do offer rather
        // than reporting only the token that failed.
        const available = (await import("../extensions/cliCommands")).describeExtensionCliCommands(
          resolved.commands,
        );
        if (available.length > 0) {
          suggestions.push("Extension commands available here:", ...available);
        }
        if (resolved.extensions.pendingTrustRepoRoot) {
          suggestions.push(
            `Open a normal review in ${resolved.extensions.pendingTrustRepoRoot} to decide whether to trust its extensions, then retry.`,
          );
        }
        if (resolved.extensions.issues.length > 0) {
          suggestions.push(
            "One or more extensions failed to load; rerun with HUNK_DEBUG=1 or open a review to inspect startup notices.",
          );
        }
        if (suggestions.length > 0) {
          throw new HunkUserError(`Unknown command: ${invocation.commandName}`, suggestions);
        }
        throw new Error(`Unknown command: ${invocation.commandName}`);
      }

      const warningMessages = [
        ...(resolved.configured.startupNotices ?? []).map((notice) => notice.message),
        ...resolved.collisionIssues.map(
          (issue) =>
            sanitizeTerminalText(issue.message).split("\n")[0] ?? "Extension CLI command collision",
        ),
      ];
      for (const message of warningMessages) {
        await new Promise<void>((resolveWrite, rejectWrite) => {
          stderr.write(`hunk: warning: ${message}\n`, (error) => {
            if (error) rejectWrite(error);
            else resolveWrite();
          });
        });
      }
      (await import("../extensions/events")).bindExtensionEventBus(resolved.extensions);
      const execution = await runExtensionCliCommandImpl({
        extensionId: registered.extensionId,
        commandName: invocation.commandName,
        args: invocation.args,
        handler: registered.handler,
        cwd: startupCwd,
        stdin: deps.extensionCliStdin,
        stdout,
        stderr,
        signals: deps.extensionCliSignals,
      });
      if (execution.result.kind === "exit") {
        const exitCode = execution.result.code ?? 0;
        await retirePreloadedExtensions();
        return { kind: "extension-cli-exit", exitCode };
      }

      if (execution.stdinReadStarted) {
        throw new HunkUserError(
          "The extension read stdin before delegating to a built-in Hunk command.",
          [
            "Delegating handlers must leave ctx.stdin untouched; return an exit result after reading it.",
          ],
        );
      }
      const delegated = await parseCliImpl([
        argv[0] ?? "hunk-runtime",
        argv[1] ?? "hunk",
        ...execution.result.argv,
      ]);
      if (delegated.kind === "extension-cli") {
        throw new HunkUserError(
          "Extension CLI commands may delegate only to built-in Hunk commands.",
        );
      }
      if (execution.result.review && delegated.kind !== "patch") {
        throw new HunkUserError(
          "Extension review metadata may be attached only to a delegated patch command.",
        );
      }
      delegatedReview = execution.result.review;
      parsedCliInput = applyDelegatedExtensionFlags(delegated, invocation);
      delegatedDiscoveryCatalog = resolved.discoveryCatalog;
    } catch (error) {
      await retirePreloadedExtensions();
      throw error;
    }
  }

  if (parsedCliInput.kind === "extension-cli") {
    throw new Error("Unreachable extension CLI delegation state.");
  }

  if (parsedCliInput.kind === "help") {
    return await finishHeadlessPlan({
      kind: "help",
      text: parsedCliInput.text,
    });
  }

  if (parsedCliInput.kind === "daemon-serve") {
    return await finishHeadlessPlan({
      kind: "daemon-serve",
    });
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
    return await finishHeadlessPlan({
      kind: "session-command",
      input: sessionInput,
    });
  }

  if (parsedCliInput.kind === "markup-render") {
    return await finishHeadlessPlan({
      kind: "markup-render",
      input: parsedCliInput,
    });
  }

  if (parsedCliInput.kind === "markup-guide") {
    return await finishHeadlessPlan({
      kind: "markup-guide",
    });
  }

  if (parsedCliInput.kind === "extension-manage") {
    return await finishHeadlessPlan({
      kind: "extension-manage",
      input: parsedCliInput,
    });
  }

  if (parsedCliInput.kind === "update") {
    return await finishHeadlessPlan({
      kind: "self-update",
      input: parsedCliInput,
    });
  }

  if (parsedCliInput.kind === "history") {
    const baseVcsCatalog = await loadBaseVcsCatalog();
    const { loadHistoryBootstrap } = await import("./historyBootstrap");
    const bootstrap = await loadHistoryBootstrap({
      input: parsedCliInput,
      cwd: startupCwd,
      env,
      baseVcsCatalog,
      previousLoad: preloadedExtensions,
    });
    // The runner owns source/extension retirement; unlike ordinary headless plans, history must
    // retain its provider cursor until every page has been consumed.
    preloadedExtensions = undefined;
    return {
      kind: parsedCliInput.interactive ? "history-interactive" : "history-static",
      bootstrap,
      input: parsedCliInput,
    };
  }

  if (parsedCliInput.kind === "pager") {
    const stdinText = await whileStartupOwnsExtensions(readStdinText);
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
        return await finishHeadlessPlan(passthroughPlan);
      }

      return await finishHeadlessPlan({
        kind: "plain-text-pager",
        text: stdinText,
      });
    }

    if (!stdoutIsTTY) {
      return await finishHeadlessPlan(passthroughPlan);
    }

    if (env.TERM === "dumb" && !capturedPagerHost) {
      return await finishHeadlessPlan(passthroughPlan);
    }

    // Captured pager hosts like LazyGit can provide a PTY while advertising TERM=dumb.
    // In that mode, emit static colored diff output instead of launching the TUI.
    if (capturedPagerHost) {
      return await finishHeadlessPlan(await staticPagerPlan());
    }

    controllingTerminal = openControllingTerminalImpl();
    if (!controllingTerminal) {
      return await finishHeadlessPlan(await staticPagerPlan());
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

  const runtimeCliInput = await whileStartupOwnsExtensions(() =>
    resolveRuntimeCliInputImpl(parsedCliInput),
  );
  // Past this point the plan always builds a changeset, so the catalog and the loading pipeline
  // are needed for certain; resolve them together rather than at each use.
  const baseVcsCatalog = await loadBaseVcsCatalog();
  let configured = await whileStartupOwnsExtensions(() =>
    resolveConfiguredCliInputImpl(runtimeCliInput, {
      cwd: startupCwd,
      env,
      vcsCatalog: delegatedDiscoveryCatalog ?? baseVcsCatalog,
    }),
  );
  // Reassigned once below if an extension VCS backend claims this checkout.
  let cliInput = configured.input;

  if (cliInput.options.watch) {
    await whileStartupOwnsExtensions(() => {
      assertReliableWatchRuntime(bunVersion);
      if (!canReloadInput(cliInput)) {
        throw new HunkUserError(
          "`--watch` requires a file- or Git-backed input that Hunk can reopen.",
          [
            "Use a patch file path instead of stdin, and avoid `--agent-context -` for watched sessions.",
          ],
        );
      }
    });
  }

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
        (await whileStartupOwnsExtensions(() =>
          detectTerminalThemeModeFromBackgroundImpl({
            input: themeInput,
            output: stdout,
          }),
        )) ?? undefined;
    }
  }

  // Extensions load before the changeset so later stages can hand their VCS adapters and
  // changeset transforms to the loading pipeline. External adapters may settle a root the
  // bundled catalog could not; the shared resolver then appends newly discovered repo
  // candidates without executing the provisional factory prefix twice.
  const [{ resolveConfiguredExtensions }, { loadConfiguredSessionBootstrap }, startupExtensions] =
    await whileStartupOwnsExtensions(() =>
      Promise.all([
        import("./extensionBootstrap"),
        import("./sessionBootstrap"),
        import("../extensions/startup"),
      ]),
    );
  const loadAppBootstrapImpl =
    deps.loadAppBootstrapImpl ??
    (await whileStartupOwnsExtensions(() => import("../core/changeset/loaders"))).loadAppBootstrap;
  const loadStartupExtensionsImpl =
    deps.loadStartupExtensionsImpl ?? startupExtensions.loadStartupExtensions;

  const resolvedExtensions = await resolveConfiguredExtensions(
    {
      runtimeInput: runtimeCliInput,
      configured,
      cwd: startupCwd,
      env,
      baseVcsCatalog,
      discoveryCatalog: delegatedDiscoveryCatalog,
      previousLoad: preloadedExtensions,
    },
    { resolveConfiguredCliInputImpl, loadStartupExtensionsImpl },
  );
  configured = resolvedExtensions.configured;
  cliInput = configured.input;
  const extensionResult = resolvedExtensions.extensions;
  preloadedExtensions = extensionResult;

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
    await retirePreloadedExtensions();
    throw error;
  }
  const { applied, bootstrap, input: resolvedInput, sessionThemes, sessionVcs } = preparedSession;
  cliInput = resolvedInput;
  if (delegatedReview) bootstrap.review = delegatedReview;

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

  // The mounted app now owns the registry and performs its one eventual shutdown.
  preloadedExtensions = undefined;
  return {
    kind: "app",
    bootstrap,
    cliInput,
    controllingTerminal,
  };
}
