import { useEffect, useState, type ComponentProps } from "react";
import { createSessionReloadBounds } from "../../packages/hunk/src/app/session/reloadBounds";
import {
  createExtensionSession,
  type ExtensionSession,
} from "../../packages/hunk/src/extensions/session";
import { createEmptyExtensionLoadResult } from "../../packages/hunk/src/extensions/types";
import { AppHost } from "../../packages/hunk/src/ui/AppHost";

type TestAppHostProps = Omit<
  ComponentProps<typeof AppHost>,
  "extensionSession" | "extensionOwnership" | "onRequestSessionShutdown"
> & {
  extensionSession?: ExtensionSession;
  extensionOwnership?: "owned" | "borrowed";
};

/** Supply explicit test-owned extension authority to an isolated AppHost mount. */
export function TestAppHost({
  extensionSession: suppliedExtensionSession,
  extensionOwnership = "owned",
  ...props
}: TestAppHostProps) {
  const [createdExtensionSession] = useState(() =>
    createExtensionSession(
      (props.bootstrap.extensions as
        | ReturnType<typeof createEmptyExtensionLoadResult>
        | undefined) ?? createEmptyExtensionLoadResult(props.bootstrap.reloadContext.cwd),
      createSessionReloadBounds(props.bootstrap, {
        cwd: props.bootstrap.reloadContext.cwd,
      }).defaultCwd,
    ),
  );
  const extensionSession = suppliedExtensionSession ?? createdExtensionSession;
  useEffect(
    () => () => {
      if (extensionOwnership === "owned") void extensionSession.shutdown();
    },
    [extensionOwnership, extensionSession],
  );
  if (extensionOwnership === "borrowed" && !suppliedExtensionSession) {
    throw new Error("Borrowed TestAppHost mounts require an explicit extension session owner.");
  }
  return (
    <AppHost
      {...props}
      extensionSession={extensionSession}
      extensionOwnership={extensionOwnership}
      onRequestSessionShutdown={
        extensionOwnership === "owned" ? () => extensionSession.shutdown() : async () => undefined
      }
    />
  );
}
