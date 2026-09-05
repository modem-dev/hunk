import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { HistoryRuntime } from "../history/types";
import { prepareEmbeddedHistoryReview } from "../runInteractiveApp";

/** Provide only the provider-neutral fields embedded review startup consumes. */
function createTestRuntime() {
  const extensionSession = { registry: {} };
  return {
    repoRoot: resolve("repository"),
    startupCwd: resolve("invocation"),
    providerId: "opaque-vcs",
    input: { extensionPaths: ["extensions/provider.ts"], extensionsEnabled: true },
    extensionSession,
  } as unknown as HistoryRuntime;
}

describe("embedded history review bootstrap", () => {
  test("preserves opaque actions, invocation-relative extensions, cwd, theme, and signal", async () => {
    const abort = new AbortController();
    let captured: { argv: string[]; deps: Record<string, unknown> } | undefined;
    const runtime = createTestRuntime();
    const result = await prepareEmbeddedHistoryReview(
      runtime,
      { kind: "revision-show", revisionId: "--opaque:id" },
      {
        themeId: "github-dark",
        themeMode: "dark",
        signal: abort.signal,
        env: {},
        prepareStartupPlanImpl: (async (argv: string[], deps: Record<string, unknown>) => {
          captured = { argv, deps };
          return {
            kind: "app",
            bootstrap: { extensions: runtime.extensionSession },
            cliInput: {},
            controllingTerminal: null,
          };
        }) as never,
      },
    );

    expect(result.bootstrap).toBeDefined();
    expect(captured?.argv).toContain(resolve("invocation", "extensions/provider.ts"));
    expect(captured?.deps).toMatchObject({
      cwd: resolve("invocation"),
      terminalThemeMode: "dark",
      signal: abort.signal,
    });
    expect(captured?.deps.borrowedExtensionLoad).toBe(runtime.extensionSession);
    expect(result.borrowsExtensions).toBe(true);
    expect(captured?.argv.join(" ")).not.toContain("--opaque:id");
  });

  test("refuses an already-cancelled bootstrap before startup", async () => {
    const abort = new AbortController();
    abort.abort();
    let called = false;
    await expect(
      prepareEmbeddedHistoryReview(
        createTestRuntime(),
        { kind: "revision-show", revisionId: "opaque" },
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
