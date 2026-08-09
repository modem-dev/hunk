import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createReviewSessionRuntime, type ReviewSessionRuntime } from "../app/reviewSessionRuntime";
import type { WatchedInputRuntime } from "../app/watchRuntime";
import type { StartupNotice } from "../core/startupNotice";
import type { AppBootstrap, CliInput } from "../core/types";
import type { HunkSessionBrokerClient } from "../session/types";
import { App } from "./App";
import { useStartupNotices } from "./hooks/useStartupNotices";

/** Keep one terminal adapter mounted over the renderer-neutral session authority. */
export function AppHost({
  bootstrap,
  hostClient,
  onQuit = () => process.exit(0),
  startupNoticeResolver,
  rawInput,
  watchRuntime,
  runtime: injectedRuntime,
}: {
  bootstrap: AppBootstrap;
  hostClient?: HunkSessionBrokerClient;
  onQuit?: () => void;
  startupNoticeResolver?: () => Promise<StartupNotice | null>;
  /** Raw invocation before config resolution; production startup always supplies this. */
  rawInput?: CliInput;
  watchRuntime?: WatchedInputRuntime;
  runtime?: ReviewSessionRuntime;
}) {
  const [runtime] = useState(
    () =>
      injectedRuntime ??
      createReviewSessionRuntime(bootstrap, {
        hostClient,
        rawInput,
        watchRuntime,
      }),
  );
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const startupNoticeText = useStartupNotices({
    enabled: !snapshot.bootstrap.input.options.pager,
    notices: snapshot.bootstrap.startupNotices,
    resolver: startupNoticeResolver,
  });

  useEffect(() => {
    runtime.start();
    return () => runtime.dispose();
  }, [runtime]);

  /** Give extension shutdown handlers a bounded window, then leave regardless. */
  const quitAfterShutdownEvent = useCallback(() => {
    void runtime.shutdown().finally(onQuit);
  }, [onQuit, runtime]);

  return (
    <App
      key={snapshot.remountVersion}
      bootstrap={snapshot.bootstrap}
      noticeText={snapshot.notice ?? startupNoticeText}
      reviewStore={snapshot.store}
      sessionRuntime={runtime}
      extensionTrustPromptRoot={snapshot.trust.promptRepoRoot}
      onCloseExtensionTrustPrompt={() => runtime.dismissTrustPrompt()}
      onDenyRepoExtensions={() => void runtime.decideExtensionTrust("denied")}
      onTrustRepoExtensions={() => void runtime.decideExtensionTrust("trusted")}
      onSessionRendererFieldsChange={(fields) => runtime.setSessionRendererFields(fields)}
      onQuit={quitAfterShutdownEvent}
      onReloadSession={(input, options) =>
        runtime.reload(options?.reason ?? "daemon", input, options)
      }
    />
  );
}
