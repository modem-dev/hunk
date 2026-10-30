import { useEffect, useState, type ComponentProps } from "react";
import { createExtensionSession } from "../../packages/hunk/src/extensions/session";
import { createEmptyExtensionLoadResult } from "../../packages/hunk/src/extensions/types";
import { AppHost } from "../../packages/hunk/src/ui/AppHost";

/** Supply explicit session ownership to an isolated benchmark AppHost mount. */
export function BenchmarkAppHost({ bootstrap }: Pick<ComponentProps<typeof AppHost>, "bootstrap">) {
  const [extensionSession] = useState(() =>
    createExtensionSession(
      (bootstrap.extensions as ReturnType<typeof createEmptyExtensionLoadResult> | undefined) ??
        createEmptyExtensionLoadResult(bootstrap.reloadContext.cwd),
      bootstrap.reloadContext.cwd,
    ),
  );
  useEffect(
    () => () => {
      void extensionSession.shutdown();
    },
    [extensionSession],
  );
  return (
    <AppHost
      bootstrap={bootstrap}
      extensionSession={extensionSession}
      extensionOwnership="owned"
      onRequestSessionShutdown={() => extensionSession.shutdown()}
    />
  );
}
