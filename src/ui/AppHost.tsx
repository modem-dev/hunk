import { useCallback, useEffect, useRef, useState } from "react";
import { resolveConfiguredExtensions } from "../app/extensionBootstrap";
import { loadConfiguredSessionBootstrap } from "../app/sessionBootstrap";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import { resolveConfiguredCliInput } from "../core/config";
import { resolveRuntimeCliInput } from "../core/terminal";
import type { StartupNotice } from "../core/startupNotice";
import type { AppBootstrap, CliInput } from "../core/types";
import type { ExtensionLoadResult } from "../extensions/types";
import {
  createUnknownVcsNotice,
  reportExtensionApplyIssues,
  resolveExtensionVcsAdapters,
} from "../extensions/apply";
import {
  emitExtensionEvent,
  emitExtensionEventBounded,
  retireExtensionLoadResult,
} from "../extensions/events";
import { extendVcsCatalog } from "../core/vcs";
import {
  createInitialSessionSnapshot,
  updateSessionRegistration,
} from "../session/app/registration";
import {
  createSessionReloadBounds,
  validateSessionReloadWithinBounds,
} from "../session/app/reloadBounds";
import type { HunkSessionBrokerClient, ReloadSessionOptions } from "../session/types";
import { App } from "./App";
import { useStartupNotices } from "./hooks/useStartupNotices";
import type { WatchedInputRuntime } from "./hooks/useWatchedInput";

/** Keep one live Hunk app mounted while allowing daemon-driven session reloads. */
export function AppHost({
  bootstrap,
  hostClient,
  onQuit = () => process.exit(0),
  startupNoticeResolver,
  watchRuntime,
}: {
  bootstrap: AppBootstrap;
  hostClient?: HunkSessionBrokerClient;
  onQuit?: () => void;
  startupNoticeResolver?: () => Promise<StartupNotice | null>;
  watchRuntime?: WatchedInputRuntime;
}) {
  const initialBootstrap = bootstrap.reloadContext.vcsCatalog
    ? bootstrap
    : {
        ...bootstrap,
        reloadContext: {
          ...bootstrap.reloadContext,
          vcsCatalog: getBundledVcsCatalog(),
        },
      };
  const [activeBootstrap, setActiveBootstrap] = useState(initialBootstrap);
  const [appVersion, setAppVersion] = useState(0);
  // Extensions outlive App remounts, and a trust grant can replace the whole
  // load result mid-session, so the host owns them rather than the bootstrap.
  const extensionsRef = useRef(initialBootstrap.extensions as ExtensionLoadResult | undefined);
  // Experimental capabilities are launch authority: remote/watch reloads may replace content,
  // but opting in or out requires starting a new Hunk process.
  const launchExperimental = initialBootstrap.input.options.experimental === true;
  // Extension authority is launch authority for the same reason. A reload command
  // names *content* to reopen — `hunk session reload <id> -- diff` — and is parsed
  // fresh, so it carries none of the extension flags the session was launched
  // with. Without re-threading them, `--no-extensions` silently stops applying on
  // the first reload (extensions the user disabled start executing again) and
  // `--extension` paths silently stop loading. Both are captured raw: `undefined`
  // means "no flag given", which must keep deferring to the config layers rather
  // than becoming an explicit choice.
  const launchExtensionsEnabled = initialBootstrap.input.options.extensions;
  const launchExtensionPaths = initialBootstrap.input.options.extensionPaths;
  const [sessionFileBounds] = useState(() =>
    createSessionReloadBounds(initialBootstrap, { cwd: initialBootstrap.reloadContext.cwd }),
  );
  // Which working directory the current extension set was discovered for.
  // Discovery is cwd-relative, so a reload that moves the session to another
  // repository has to re-run it: that repo's extensions — and the trust
  // question they raise — belong to it, not to the one Hunk launched in. Seeded
  // from the bounds' cwd so it compares against the same resolved form reloads
  // produce, and a same-directory reload is not mistaken for a move.
  const extensionsCwdRef = useRef(sessionFileBounds.defaultCwd);
  const initialExtensionStartupPendingRef = useRef(true);
  const reloadTailRef = useRef<Promise<void>>(Promise.resolve());
  const pendingReplacementLifecycleRef = useRef<{
    extensions: ExtensionLoadResult;
    cwd: string;
    changeset: AppBootstrap["changeset"];
    reason: NonNullable<ReloadSessionOptions["reason"]>;
    resolveMounted: () => void;
  } | null>(null);
  const startupNoticeText = useStartupNotices({
    enabled: !activeBootstrap.input.options.pager,
    notices: activeBootstrap.startupNotices,
    resolver: startupNoticeResolver,
  });

  useEffect(() => {
    // Child effects run before the parent's, so by the time this fires the review
    // UI has rendered the matching bootstrap and installed live extension controls.
    if (initialExtensionStartupPendingRef.current) {
      initialExtensionStartupPendingRef.current = false;
      emitExtensionEvent(extensionsRef.current, "startup", {
        cwd: initialBootstrap.reloadContext.cwd,
      });
      return;
    }

    const pending = pendingReplacementLifecycleRef.current;
    if (!pending) {
      return;
    }
    pendingReplacementLifecycleRef.current = null;
    emitExtensionEvent(pending.extensions, "startup", { cwd: pending.cwd });
    emitExtensionEvent(pending.extensions, "session_reload", {
      changeset: pending.changeset,
      reason: pending.reason,
    });
    pending.resolveMounted();
  }, [activeBootstrap, initialBootstrap.reloadContext.cwd]);

  const performReloadSession = useCallback(
    async (nextInput: CliInput, options?: ReloadSessionOptions) => {
      // Re-run the same startup normalization pipeline used on first launch so reloads honor
      // runtime defaults and config layering instead of assuming `nextInput` is already final.
      // `sourcePath` matters for daemon-driven reloads that ask Hunk to reopen content from a
      // different working directory than the process originally started in.
      const runtimeInput = resolveRuntimeCliInput({
        ...nextInput,
        options: {
          ...nextInput.options,
          experimental: launchExperimental,
          extensions: launchExtensionsEnabled,
          extensionPaths: launchExtensionPaths,
        },
      });
      const { cwd } = validateSessionReloadWithinBounds(sessionFileBounds, runtimeInput, {
        sourcePath: options?.sourcePath,
      });
      const baseVcsCatalog = getBundledVcsCatalog();
      const currentExtensions = extensionsRef.current;
      const currentAdapters = currentExtensions
        ? resolveExtensionVcsAdapters(currentExtensions.registry, baseVcsCatalog).adapters
        : [];
      const discoveryCatalog = extendVcsCatalog(baseVcsCatalog, currentAdapters);
      let configured = resolveConfiguredCliInput(runtimeInput, {
        cwd,
        vcsCatalog: discoveryCatalog,
      });
      let replacementExtensions: ExtensionLoadResult | undefined;

      if (options?.reloadExtensions || cwd !== extensionsCwdRef.current) {
        const resolvedExtensions = await resolveConfiguredExtensions({
          runtimeInput,
          configured,
          cwd,
          baseVcsCatalog,
          discoveryCatalog,
          // Reuse the session hub so the mounted toast surface keeps receiving notifications.
          notifications: currentExtensions?.notifications,
        });
        configured = resolvedExtensions.configured;
        replacementExtensions = resolvedExtensions.extensions;
      }

      const extensions = replacementExtensions ?? currentExtensions;
      const preparedReload = await (async () => {
        try {
          const {
            applied,
            bootstrap: nextBootstrap,
            input: reloadInput,
            sessionVcs,
          } = await loadConfiguredSessionBootstrap({
            configured,
            cwd,
            extensions,
            loadAtCwd: true,
            baseVcsCatalog,
          });
          if (extensions) {
            reportExtensionApplyIssues(applied.issues, extensions.context);
          }
          nextBootstrap.startupNotices =
            sessionVcs.unknownVcsId !== undefined
              ? [
                  ...(configured.startupNotices ?? []),
                  // Names the backend the reload really used, detection override included.
                  createUnknownVcsNotice(sessionVcs.unknownVcsId, String(reloadInput.options.vcs)),
                ]
              : configured.startupNotices;
          const nextSnapshot = createInitialSessionSnapshot(nextBootstrap);

          let sessionId = "local-session";
          if (hostClient) {
            // Keep the daemon-facing registration aligned with the review about to mount.
            const nextRegistration = updateSessionRegistration(
              hostClient.getRegistration(),
              nextBootstrap,
            );
            sessionId = nextRegistration.sessionId;
            hostClient.replaceSession(nextRegistration, nextSnapshot);
          }
          return { nextBootstrap, nextSnapshot, sessionId };
        } catch (error) {
          await retireExtensionLoadResult(replacementExtensions);
          throw error;
        }
      })();
      const { nextBootstrap, nextSnapshot, sessionId } = preparedReload;

      let replacementMounted: Promise<void> | undefined;
      let currentExtensionsRetired: Promise<void> | undefined;
      if (replacementExtensions) {
        // Only retire the visible runtime after its replacement review is known-good.
        // Revocation is synchronous so mounted controls and modes become inert
        // before shutdown starts; React then tears them down on this state update.
        // `retireExtensionLoadResult` revokes synchronously before its first await.
        currentExtensionsRetired = retireExtensionLoadResult(currentExtensions);
        extensionsRef.current = replacementExtensions;
        extensionsCwdRef.current = cwd;
        replacementMounted = new Promise<void>((resolveMounted) => {
          pendingReplacementLifecycleRef.current = {
            extensions: replacementExtensions,
            cwd,
            changeset: nextBootstrap.changeset,
            reason: options?.reason ?? "daemon",
            resolveMounted,
          };
        });
      }

      setActiveBootstrap(nextBootstrap);
      if (options?.resetApp !== false) {
        // Bumping the key forces a full App remount. Callers that pass `resetApp: false` get a
        // soft reload that preserves in-memory UI state like selection, filter text, and pane size.
        setAppVersion((current) => current + 1);
      }

      if (!replacementExtensions) {
        emitExtensionEvent(extensions, "session_reload", {
          changeset: nextBootstrap.changeset,
          reason: options?.reason ?? "daemon",
        });
      } else {
        // Keep the reload queue held until React commits the matching App and
        // the replacement receives startup/session_reload through live controls.
        await Promise.all([replacementMounted, currentExtensionsRetired]);
      }

      return {
        sessionId,
        inputKind: nextBootstrap.input.kind,
        title: nextBootstrap.changeset.title,
        sourceLabel: nextBootstrap.changeset.sourceLabel,
        fileCount: nextBootstrap.changeset.files.length,
        selectedFilePath: nextSnapshot.state.selectedFilePath,
        selectedHunkIndex: nextSnapshot.state.selectedHunkIndex,
      };
    },
    [
      hostClient,
      launchExperimental,
      launchExtensionsEnabled,
      launchExtensionPaths,
      sessionFileBounds,
    ],
  );

  /** Serialize broker, watch, workspace, and manual reloads around extension replacement. */
  const reloadSession = useCallback(
    (nextInput: CliInput, options?: ReloadSessionOptions) => {
      const pending = reloadTailRef.current.then(() => performReloadSession(nextInput, options));
      reloadTailRef.current = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
    [performReloadSession],
  );

  /** Give `shutdown` handlers a bounded window, then leave regardless. */
  const quitAfterShutdownEvent = useCallback(() => {
    void emitExtensionEventBounded(extensionsRef.current, "shutdown", {}).finally(onQuit);
  }, [onQuit]);

  return (
    <App
      key={appVersion}
      bootstrap={activeBootstrap}
      hostClient={hostClient}
      noticeText={startupNoticeText}
      onQuit={quitAfterShutdownEvent}
      onReloadSession={reloadSession}
      watchRuntime={watchRuntime}
    />
  );
}
