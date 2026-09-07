import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { createEmptyExtensionLoadResult } from "../extensions/types";
import { prepareEmbeddedHistoryReview } from "./historyReview";

/** Provide only the provider-neutral fields embedded review startup consumes. */
function createTestRequest() {
  const extensionSession = createEmptyExtensionLoadResult(resolve("invocation"));
  return {
    action: { kind: "revision-show", revisionId: "--opaque:id" } as const,
    startupCwd: resolve("invocation"),
    providerId: "opaque-vcs",
    extensionPaths: ["extensions/provider.ts"],
    extensionsEnabled: true,
    extensionSession,
  };
}

describe("embedded history review bootstrap", () => {
  test("preserves opaque actions, invocation-relative extensions, cwd, theme, and signal", async () => {
    const abort = new AbortController();
    let captured: { argv: string[]; deps: Record<string, unknown> } | undefined;
    const request = createTestRequest();
    const result = await prepareEmbeddedHistoryReview(
      { ...request, themeId: "github-dark", themeMode: "dark" },
      {
        signal: abort.signal,
        env: {},
        prepareStartupPlanImpl: (async (argv: string[], deps: Record<string, unknown>) => {
          captured = { argv, deps };
          return {
            kind: "app",
            bootstrap: { extensions: { ...request.extensionSession } },
            cliInput: {},
            controllingTerminal: null,
            initialization: { theme: { customThemes: [] } },
          };
        }) as never,
      },
    );

    expect(result.bootstrap).toBeDefined();
    expect(result.initialization).toEqual({ theme: { customThemes: [] } });
    expect(captured?.argv).toContain(resolve("invocation", "extensions/provider.ts"));
    expect(captured?.deps).toMatchObject({
      cwd: resolve("invocation"),
      terminalThemeMode: "dark",
      signal: abort.signal,
    });
    expect(captured?.deps.borrowedExtensionLoad).toBe(request.extensionSession);
    expect(result.borrowsExtensions).toBe(true);
    expect(captured?.argv.join(" ")).not.toContain("--opaque:id");
  });

  test("does not retire an aliased borrowed registry when cancellation wins after startup", async () => {
    const abort = new AbortController();
    const request = createTestRequest();
    const close = mock(() => undefined);

    await expect(
      prepareEmbeddedHistoryReview(request, {
        signal: abort.signal,
        prepareStartupPlanImpl: (async () => {
          abort.abort();
          return {
            kind: "app",
            bootstrap: { extensions: { ...request.extensionSession } },
            cliInput: {},
            controllingTerminal: { close },
            initialization: { theme: { customThemes: [] } },
          };
        }) as never,
      }),
    ).rejects.toThrow();

    expect(close).toHaveBeenCalledTimes(1);
    expect(request.extensionSession.registry.retirementPromise).toBeUndefined();
  });

  test("refuses an already-cancelled bootstrap before startup", async () => {
    const abort = new AbortController();
    abort.abort();
    let called = false;
    await expect(
      prepareEmbeddedHistoryReview(
        { ...createTestRequest(), action: { kind: "revision-show", revisionId: "opaque" } },
        {
          signal: abort.signal,
          prepareStartupPlanImpl: (async () => {
            called = true;
            return { kind: "help", text: "unexpected" };
          }) as never,
        },
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});
