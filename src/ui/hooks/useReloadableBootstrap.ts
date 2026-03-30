import { useCallback, useState } from "react";
import { resolveConfiguredCliInput } from "../../core/config";
import { loadAppBootstrap } from "../../core/loaders";
import { resolveRuntimeCliInput } from "../../core/terminal";
import type { AppBootstrap, CliInput } from "../../core/types";
import { HunkHostClient } from "../../mcp/client";
import {
  createInitialSessionSnapshot,
  updateSessionRegistration,
} from "../../mcp/sessionRegistration";
import type { ReloadedSessionResult } from "../../mcp/types";

/** Keep one live app bootstrap mounted while allowing in-place session reloads. */
export function useReloadableBootstrap(bootstrap: AppBootstrap, hostClient?: HunkHostClient) {
  const [activeBootstrap, setActiveBootstrap] = useState(bootstrap);
  const [shellVersion, setShellVersion] = useState(0);

  const reloadSession = useCallback(
    async (nextInput: CliInput, options?: { resetShell?: boolean; sourcePath?: string }) => {
      const runtimeInput = resolveRuntimeCliInput(nextInput);
      const configuredInput = resolveConfiguredCliInput(runtimeInput, {
        cwd: options?.sourcePath,
      }).input;
      const nextBootstrap = await loadAppBootstrap(configuredInput, {
        cwd: options?.sourcePath,
      });
      const nextSnapshot = createInitialSessionSnapshot(nextBootstrap);

      let sessionId = "local-session";
      if (hostClient) {
        const nextRegistration = updateSessionRegistration(
          hostClient.getRegistration(),
          nextBootstrap,
        );
        sessionId = nextRegistration.sessionId;
        hostClient.replaceSession(nextRegistration, nextSnapshot);
      }

      setActiveBootstrap(nextBootstrap);
      if (options?.resetShell !== false) {
        setShellVersion((current) => current + 1);
      }

      return {
        sessionId,
        inputKind: nextBootstrap.input.kind,
        title: nextBootstrap.changeset.title,
        sourceLabel: nextBootstrap.changeset.sourceLabel,
        fileCount: nextBootstrap.changeset.files.length,
        selectedFilePath: nextSnapshot.selectedFilePath,
        selectedHunkIndex: nextSnapshot.selectedHunkIndex,
      } satisfies ReloadedSessionResult;
    },
    [hostClient],
  );

  return { activeBootstrap, reloadSession, shellVersion };
}
