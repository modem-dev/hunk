import type { DocumentBrowserBootstrap } from "../../core/documents/bootstrap";
import { DocumentBrowserController } from "./controller";
import { HunkSessionHost } from "../session/HunkSessionHost";
import { runHunkSession } from "../session/runHunkSession";

/** Mount documents in the existing session host; the runner retains all terminal ownership. */
export async function runDocumentBrowser(bootstrap: DocumentBrowserBootstrap) {
  const controller = new DocumentBrowserController(bootstrap.source);
  try {
    await controller.initialize();
    await runHunkSession({
      stdin: process.stdin,
      stdout: process.stdout,
      useMouse: true,
      signals:
        process.platform === "win32"
          ? ["SIGINT", "SIGTERM", "SIGBREAK"]
          : ["SIGINT", "SIGTERM", "SIGHUP"],
      beforeTeardown: () => controller.close(),
      render: ({ externalQuitSignal, finish }) => (
        <HunkSessionHost
          initialRoute={{ kind: "documents", bootstrap, controller }}
          initialization={bootstrap.initialization}
          externalQuitSignal={externalQuitSignal}
          onQuit={finish}
        />
      ),
    });
  } finally {
    await controller.close();
  }
}
