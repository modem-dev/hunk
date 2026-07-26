import { useCallback, useEffect, useRef, useState } from "react";
import { resolveConfiguredCliInput } from "../core/config";
import { collectSessionCustomThemes } from "../core/customThemes";
import { loadAppBootstrap } from "../core/loaders";
import { resolveRuntimeCliInput } from "../core/terminal";
import type { StartupNotice } from "../core/startupNotice";
import type { AppBootstrap, CliInput } from "../core/types";
import {
  applyExtensionChangesetTransforms,
  applyExtensionRegistrations,
  createUnknownVcsNotice,
  reportExtensionApplyIssues,
  resolveDetectedVcsIdWithExtensions,
  resolveSessionVcsId,
} from "../extensions/apply";
import {
  emitExtensionEvent,
  emitExtensionEventBounded,
  emitExtensionEventToExtensions,
} from "../extensions/events";
import { loadStartupExtensions } from "../extensions/startup";
import {
  createInitialSessionSnapshot,
  updateSessionRegistration,
} from "../hunk-session/sessionRegistration";
import {
  createSessionReloadBounds,
  validateSessionReloadWithinBounds,
} from "../hunk-session/sessionFileBounds";
import type { HunkSessionBrokerClient, ReloadSessionOptions } from "../hunk-session/types";
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
  const [activeBootstrap, setActiveBootstrap] = useState(bootstrap);
  const [appVersion, setAppVersion] = useState(0);
  // Extensions outlive App remounts, and a trust grant can replace the whole
  // load result mid-session, so the host owns them rather than the bootstrap.
  const extensionsRef = useRef(bootstrap.extensions);
  // Experimental capabilities are launch authority: remote/watch reloads may replace content,
  // but opting in or out requires starting a new Hunk process.
  const launchExperimental = bootstrap.input.options.experimental === true;
  // Extension authority is launch authority for the same reason. A reload command
  // names *content* to reopen — `hunk session reload <id> -- diff` — and is parsed
  // fresh, so it carries none of the extension flags the session was launched
  // with. Without re-threading them, `--no-extensions` silently stops applying on
  // the first reload (extensions the user disabled start executing again) and
  // `--extension` paths silently stop loading. Both are captured raw: `undefined`
  // means "no flag given", which must keep deferring to the config layers rather
  // than becoming an explicit choice.
  const launchExtensionsEnabled = bootstrap.input.options.extensions;
  const launchExtensionPaths = bootstrap.input.options.extensionPaths;
  const [sessionFileBounds] = useState(() =>
    createSessionReloadBounds(bootstrap, { cwd: bootstrap.reloadContext.cwd }),
  );
  // Which working directory the current extension set was discovered for.
  // Discovery is cwd-relative, so a reload that moves the session to another
  // repository has to re-run it: that repo's extensions — and the trust
  // question they raise — belong to it, not to the one Hunk launched in. Seeded
  // from the bounds' cwd so it compares against the same resolved form reloads
  // produce, and a same-directory reload is not mistaken for a move.
  const extensionsCwdRef = useRef(sessionFileBounds.defaultCwd);
  const startupNoticeText = useStartupNotices({
    enabled: !activeBootstrap.input.options.pager,
    notices: activeBootstrap.startupNotices,
    resolver: startupNoticeResolver,
  });

  // Extensions that have already received `startup`. The event is a per-extension
  // promise, not a per-session one, so a pass that loads extensions later — the
  // trust grant, or a reload into another repository — owes `startup` to exactly
  // the ones that missed it, and owes nothing to the ones that already had it.
  const startedExtensionIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Child effects run before the parent's, so by the time this fires the review
    // UI is mounted with its first changeset — which is what `startup` promises.
    const extensions = extensionsRef.current;
    for (const { id } of extensions?.loaded ?? []) {
      startedExtensionIdsRef.current.add(id);
    }

    emitExtensionEvent(extensions, "startup", {
      cwd: bootstrap.reloadContext.cwd,
    });
  }, [bootstrap.reloadContext.cwd]);

  const reloadSession = useCallback(
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
      const configured = resolveConfiguredCliInput(runtimeInput, { cwd });

      // Extensions loaded before this pass; used below to tell newly loaded ones apart.
      const previouslyLoadedIds = new Set(
        (extensionsRef.current?.loaded ?? []).map((extension) => extension.id),
      );
      let reloadedExtensions = false;

      if (options?.reloadExtensions || cwd !== extensionsCwdRef.current) {
        // Reuse the session's notification hub so the mounted toast surface keeps
        // receiving `ctx.notify` from the extensions this pass loads.
        extensionsRef.current = await loadStartupExtensions({
          extensions: configured.extensions,
          cwd,
          cliExtensionPaths: configured.input.options.extensionPaths,
          notifications: extensionsRef.current?.notifications,
        });
        extensionsCwdRef.current = cwd;
        reloadedExtensions = true;
      }

      const extensions = extensionsRef.current;
      // Registrations are reapplied every reload so a pass that added extensions
      // contributes exactly what a fresh launch would have.
      const applied = applyExtensionRegistrations(extensions);
      if (extensions) {
        reportExtensionApplyIssues(applied.issues, extensions.context);
      }

      // Extensions are loaded once per process, so a reload re-merges the same registry themes
      // instead of dropping them from the selector.
      const sessionThemes = collectSessionCustomThemes(
        configured.customThemes,
        extensions?.registry.themes,
      );

      // Config resolution above ran before extension adapters were in hand, exactly
      // as it does on first launch — so repeat both VCS steps `prepareStartupPlan`
      // performs, in the same order. Without them, a reload into an
      // extension-backed repository (a daemon cross-directory reload, say)
      // resolves to the backend config guessed without extensions and reviews the
      // wrong thing, while first launch in that same directory works.
      const sessionVcs = resolveSessionVcsId(
        configured.input.options.vcs,
        cwd,
        applied.vcsAdapters,
      );
      const detectedVcsId = resolveDetectedVcsIdWithExtensions(
        cwd,
        applied.vcsAdapters,
        configured.explicitVcsId,
      );
      const reloadVcsId = detectedVcsId ?? sessionVcs.vcsId;
      const reloadInput =
        reloadVcsId === configured.input.options.vcs
          ? configured.input
          : { ...configured.input, options: { ...configured.input.options, vcs: reloadVcsId } };

      const nextBootstrap = await loadAppBootstrap(reloadInput, {
        cwd,
        customThemes: sessionThemes.themes,
        vcsAdapters: applied.vcsAdapters,
      });
      nextBootstrap.changeset = await applyExtensionChangesetTransforms(
        extensions,
        nextBootstrap.changeset,
      );
      nextBootstrap.extensions = extensions;
      nextBootstrap.startupNotices =
        sessionVcs.unknownVcsId !== undefined
          ? [
              ...(configured.startupNotices ?? []),
              // Names the backend the reload really used, detection override included.
              createUnknownVcsNotice(sessionVcs.unknownVcsId, String(reloadVcsId)),
            ]
          : configured.startupNotices;
      nextBootstrap.viewPreferencesConfigPath = configured.viewPreferencesConfigPath;
      const nextSnapshot = createInitialSessionSnapshot(nextBootstrap);

      let sessionId = "local-session";
      if (hostClient) {
        // Keep the daemon-facing session registration in sync with whatever the UI is about to
        // show. Replacing both registration and snapshot here means external session commands see
        // the new source, title, and selection baseline immediately after reload.
        const nextRegistration = updateSessionRegistration(
          hostClient.getRegistration(),
          nextBootstrap,
        );
        sessionId = nextRegistration.sessionId;
        hostClient.replaceSession(nextRegistration, nextSnapshot);
      }

      setActiveBootstrap(nextBootstrap);
      if (options?.resetApp !== false) {
        // Bumping the key forces a full App remount. Callers that pass `resetApp: false` get a
        // soft reload that preserves in-memory UI state like selection, filter text, and pane size.
        setAppVersion((current) => current + 1);
      }

      if (reloadedExtensions) {
        // Extensions this pass loaded for the first time — after a trust grant, or
        // after moving into another repository — never saw the mount emit, so they
        // get `startup` now that the review UI is showing their changeset. Ordered
        // before `session_reload` so an extension's own lifecycle stays in sequence.
        const newlyLoadedIds = new Set(
          (extensions?.loaded ?? [])
            .map((extension) => extension.id)
            .filter(
              (id) => !previouslyLoadedIds.has(id) && !startedExtensionIdsRef.current.has(id),
            ),
        );

        for (const id of newlyLoadedIds) {
          startedExtensionIdsRef.current.add(id);
        }

        emitExtensionEventToExtensions(extensions, "startup", { cwd }, newlyLoadedIds);
      }

      emitExtensionEvent(extensions, "session_reload", {
        changeset: nextBootstrap.changeset,
        reason: options?.reason ?? "daemon",
      });

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
