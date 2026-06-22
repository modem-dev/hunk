import { useCallback, useState } from "react";
import { resolveConfiguredCliInput } from "../core/config";
import { loadAppBootstrap } from "../core/loaders";
import { resolveRuntimeCliInput } from "../core/terminal";
import type { AppBootstrap, CliInput } from "../core/types";
import type { UpdateNotice } from "../core/updateNotice";
import {
  createInitialSessionSnapshot,
  updateSessionRegistration,
} from "../hunk-session/sessionRegistration";
import {
  createSessionReloadBounds,
  validateSessionReloadWithinBounds,
} from "../hunk-session/sessionFileBounds";
import type { HunkSessionBrokerClient } from "../hunk-session/types";
import { App } from "./App";
import { useStartupUpdateNotice } from "./hooks/useStartupUpdateNotice";

/** Keep one live Hunk app mounted while allowing daemon-driven session reloads. */
export function AppHost({
  bootstrap,
  hostClient,
  onQuit = () => process.exit(0),
  startupNoticeResolver,
}: {
  bootstrap: AppBootstrap;
  hostClient?: HunkSessionBrokerClient;
  onQuit?: () => void;
  startupNoticeResolver?: () => Promise<UpdateNotice | null>;
}) {
  const [activeBootstrap, setActiveBootstrap] = useState(bootstrap);
  const [appVersion, setAppVersion] = useState(0);
  const [sessionFileBounds] = useState(() =>
    createSessionReloadBounds(bootstrap, {
      cwd: hostClient?.getRegistration().cwd,
    }),
  );
  const startupNoticeText = useStartupUpdateNotice({
    enabled: !bootstrap.input.options.pager,
    resolver: startupNoticeResolver,
  });

  const reloadSession = useCallback(
    async (nextInput: CliInput, options?: { resetApp?: boolean; sourcePath?: string }) => {
      // Re-run the same startup normalization pipeline used on first launch so reloads honor
      // runtime defaults and config layering instead of assuming `nextInput` is already final.
      // `sourcePath` matters for daemon-driven reloads that ask Hunk to reopen content from a
      // different working directory than the process originally started in.
      const runtimeInput = resolveRuntimeCliInput(nextInput);
      const { cwd } = validateSessionReloadWithinBounds(sessionFileBounds, runtimeInput, {
        sourcePath: options?.sourcePath,
      });
      const configured = resolveConfiguredCliInput(runtimeInput, { cwd });
      const nextBootstrap = await loadAppBootstrap(configured.input, {
        cwd,
        customTheme: configured.customTheme,
      });
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
    [hostClient, sessionFileBounds],
  );

  return (
    <App
      key={appVersion}
      bootstrap={activeBootstrap}
      hostClient={hostClient}
      noticeText={startupNoticeText}
      onQuit={onQuit}
      onReloadSession={reloadSession}
    />
  );
}
