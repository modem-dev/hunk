import { createSignal, For } from "solid-js";
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
export function AppHost(props: {
  bootstrap: AppBootstrap;
  hostClient?: HunkSessionBrokerClient;
  onQuit?: () => void;
  startupNoticeResolver?: () => Promise<UpdateNotice | null>;
}) {
  const onQuit = props.onQuit ?? (() => process.exit(0));
  const [activeBootstrap, setActiveBootstrap] = createSignal(props.bootstrap);
  const [appVersion, setAppVersion] = createSignal(0);
  // Reload bounds are derived once from the initial bootstrap (was useState lazy init).
  const sessionFileBounds = createSessionReloadBounds(props.bootstrap, {
    cwd: props.hostClient?.getRegistration().cwd,
  });
  const startupNoticeText = useStartupUpdateNotice({
    enabled: !props.bootstrap.input.options.pager,
    resolver: props.startupNoticeResolver,
  });

  const reloadSession = async (
    nextInput: CliInput,
    options?: { resetApp?: boolean; sourcePath?: string },
  ) => {
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
    if (props.hostClient) {
      // Keep the daemon-facing session registration in sync with whatever the UI is about to
      // show. Replacing both registration and snapshot here means external session commands see
      // the new source, title, and selection baseline immediately after reload.
      const nextRegistration = updateSessionRegistration(
        props.hostClient.getRegistration(),
        nextBootstrap,
      );
      sessionId = nextRegistration.sessionId;
      props.hostClient.replaceSession(nextRegistration, nextSnapshot);
    }

    setActiveBootstrap(nextBootstrap);
    if (options?.resetApp !== false) {
      // Bumping the version forces a full App remount via the keyed <Show>. Callers that pass
      // `resetApp: false` get a soft reload that preserves in-memory UI state like selection,
      // filter text, and pane size (App keeps its signals; only the bootstrap prop changes).
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
  };

  // Iterating a single-element array keyed by appVersion remounts the App subtree (fresh signal
  // scope = reset state) whenever a hard reload bumps the version. Soft reloads leave the version
  // unchanged, so App stays mounted and its reactive prop bindings update it in place instead.
  // (This solid-js build types keyed <Show> children as a static Element, so <For> is used to get
  // a remount with function children.)
  return (
    <For each={[appVersion()]}>
      {() => (
        <App
          bootstrap={activeBootstrap()}
          hostClient={props.hostClient}
          noticeText={startupNoticeText()}
          onQuit={onQuit}
          onReloadSession={reloadSession}
        />
      )}
    </For>
  );
}
