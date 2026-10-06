import { expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { DocumentSource } from "../../core/documents/source";
import { resolveConfiguredInput } from "../../core/run/config";
import { createInteractiveSessionInitialization } from "../../core/session/initialization";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";
import { HunkSessionHost } from "../session/HunkSessionHost";
import { DocumentBrowserController } from "./controller";

/** Create a document route whose opaque identities deliberately are not filesystem paths. */
async function createTestDocumentRoute() {
  const source: DocumentSource = {
    root: { key: "collection:opaque", name: "Collection", kind: "directory", hidden: false },
    async list() {
      return {
        kind: "entries",
        entries: [{ key: "document:opaque", name: "example.ts", kind: "file", hidden: false }],
      };
    },
    async read() {
      return {
        kind: "text",
        text:
          "const completeDocument = 42;\n" +
          Array.from({ length: 80 }, (_, index) => `// Row ${index + 1}`).join("\n"),
        identity: "stable",
        language: "typescript",
      };
    },
  };
  const controller = new DocumentBrowserController(source);
  await controller.initialize();
  const options = { theme: "github-dark-default", lineNumbers: true };
  const initialization = createInteractiveSessionInitialization({
    theme: { initialTheme: options.theme },
    viewPreferences: persistedViewPreferencesFromOptions(options),
  });
  const configured = resolveConfiguredInput({ kind: "open", path: ".", options }, { env: {} });
  configured.keybindings = { "hunk.documents.stepDown": "n" };
  return {
    kind: "documents" as const,
    controller,
    bootstrap: { source, configured, initialization },
  };
}

test("the session host mounts documents, honors remaps and acknowledges external quit without a review runtime", async () => {
  const route = await createTestDocumentRoute();
  const abort = new AbortController();
  const quit = mock(() => undefined);
  const createReview = mock(() => {
    throw new Error("Documents must not create review runtimes.");
  });
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={route}
      initialization={route.bootstrap.initialization}
      externalQuitSignal={abort.signal}
      onQuit={quit}
      deps={{ createReviewRuntime: createReview }}
    />,
    { width: 90, height: 20 },
  );
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("example.ts");
    await act(async () => setup.mockInput.pressKey("j"));
    expect(route.controller.getSnapshot().selectedKey).toBe("collection:opaque");
    await act(async () => {
      setup.mockInput.pressKey("n");
      await Bun.sleep(20);
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("const completeDocument = 42;");
    expect(setup.captureCharFrame()).not.toContain("document:opaque");
    const edit = mock(async (_key: string) => "Source-owned editor capability invoked.");
    route.controller.source.edit = edit;
    await act(async () => {
      setup.mockInput.pressKey("e");
      await Bun.sleep(20);
    });
    await setup.renderOnce();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]?.[0]).toBe("document:opaque");
    expect(setup.captureCharFrame()).toContain("Source-owned editor capability");
    await act(async () => setup.mockInput.pressKey("?"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Documents");
    await act(async () => {
      setup.mockInput.pressKey("e");
      setup.mockInput.pressKey("n");
      await Bun.sleep(20);
    });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(route.controller.getSnapshot().selectedKey).toBe("document:opaque");
    await act(async () => {
      setup.mockInput.pressEscape();
      await Bun.sleep(50);
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("Controls help");
    await act(async () => setup.mockInput.pressTab());
    await act(async () => setup.mockInput.pressArrow("down"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("const completeDocument = 42;");
    await act(async () => setup.mockInput.pressKey("n"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("const completeDocument = 42;");
    await act(async () => abort.abort());
    expect(quit).toHaveBeenCalledTimes(1);
    expect(createReview).not.toHaveBeenCalled();
  } finally {
    await act(async () => setup.renderer.destroy());
    await route.controller.close();
  }
});
