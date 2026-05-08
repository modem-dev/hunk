import { describe, expect, test } from "bun:test";
import { HunkUserError } from "./errors";
import { prepareStartupPlan } from "./startup";
import type { LineSource } from "./streaming/stdinLines";
import type { AppBootstrap, CliInput, ParsedCliInput } from "./types";

function lineSourceFromString(text: string): LineSource {
  // Mirror real stdinLines: split on \n and drop a trailing empty line so a final newline
  // does not produce a phantom empty line.
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) yield line;
    },
  };
}

function createBootstrap(input: CliInput): AppBootstrap {
  return {
    input,
    changeset: {
      id: "changeset:startup",
      sourceLabel: "repo",
      title: "repo working tree",
      files: [],
    },
    initialMode: input.options.mode ?? "auto",
  };
}

describe("startup planning", () => {
  test("returns help output without entering app startup", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk"], {
      parseCliImpl: async () => ({ kind: "help", text: "Usage: hunk\n" }),
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "help", text: "Usage: hunk\n" });
    expect(loaded).toBe(false);
  });

  test("passes the daemon serve command through without app bootstrap work", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk", "daemon", "serve"], {
      parseCliImpl: async () => ({ kind: "daemon-serve" }),
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "daemon-serve" });
    expect(loaded).toBe(false);
  });

  test("passes session commands through without app bootstrap work", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk", "session", "list"], {
      parseCliImpl: async () => ({ kind: "session", action: "list", output: "text" }),
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({
      kind: "session-command",
      input: { kind: "session", action: "list", output: "text" },
    });
    expect(loaded).toBe(false);
  });

  test("routes non-diff pager stdin to the plain-text pager path", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({ kind: "pager", options: { theme: "paper" } }),
      readStdinLines: () => lineSourceFromString("* main\n  feature/demo\n"),
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "plain-text-pager", text: "* main\n  feature/demo\n" });
    expect(loaded).toBe(false);
  });

  test("routes single-changeset pager input through the buffered review path", async () => {
    // Plain `diff --git` input with no commit headers: auto-detect should NOT trigger,
    // so the pager runs the legacy buffered path and registers with the daemon as
    // before. This preserves the agent review surface for `git diff | hunk pager`.
    const seenInputs: CliInput[] = [];

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({ kind: "pager", options: { theme: "paper" } }),
      readStdinLines: () =>
        lineSourceFromString("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"),
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
      loadAppBootstrapImpl: async (input) => {
        seenInputs.push(input);
        return createBootstrap(input);
      },
      usesPipedPatchInputImpl: () => false,
    });

    expect(plan.kind).toBe("app");
    if (plan.kind !== "app") throw new Error("Expected app startup plan.");

    expect(plan.cliInput).toMatchObject({
      kind: "patch",
      file: "-",
      text: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      options: { theme: "paper", pager: true, noReview: undefined },
    });
    expect(plan.bootstrap.stream).toBeUndefined();
    expect(seenInputs).toHaveLength(1);
  });

  test("auto-routes log-style pager input to streaming no-review mode", async () => {
    // Presence of a `commit <sha>` header in the prefix flips auto-detect: streaming
    // pipeline, no daemon registration, inline commit metadata.
    const stdin = [
      "commit abc1234567",
      "Author: Alice <alice@example.com>",
      "Date:   2026-01-01",
      "",
      "    first commit",
      "",
      "diff --git a/a.ts b/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({ kind: "pager", options: {} }),
      readStdinLines: () => lineSourceFromString(stdin),
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
      // Streaming + no-review skips loadAppBootstrap entirely.
      loadAppBootstrapImpl: async () => {
        throw new Error("loadAppBootstrap should not be called for log-style pager input");
      },
      usesPipedPatchInputImpl: () => false,
    });

    expect(plan.kind).toBe("app");
    if (plan.kind !== "app") throw new Error("Expected app startup plan.");

    expect(plan.cliInput.options.noReview).toBe(true);
    expect(plan.cliInput.options.pager).toBe(true);
    expect(plan.bootstrap.stream).toBeDefined();
    expect(plan.bootstrap.changeset.files).toEqual([]);
    expect(plan.bootstrap.changeset.isStreaming).toBe(true);

    plan.bootstrap.stream?.abort();
  });

  test("--no-review flag forces streaming even on non-log-style input", async () => {
    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({ kind: "pager", options: { noReview: true } }),
      readStdinLines: () =>
        lineSourceFromString("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"),
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
      loadAppBootstrapImpl: async () => {
        throw new Error("loadAppBootstrap should not be called when --no-review is set");
      },
      usesPipedPatchInputImpl: () => false,
    });

    expect(plan.kind).toBe("app");
    if (plan.kind !== "app") throw new Error("Expected app startup plan.");
    expect(plan.cliInput.options.noReview).toBe(true);
    expect(plan.bootstrap.stream).toBeDefined();

    plan.bootstrap.stream?.abort();
  });

  test("--review flag forces buffered review path on log-style input", async () => {
    const stdin = [
      "commit abc1234567",
      "Author: A <a@a>",
      "",
      "    msg",
      "",
      "diff --git a/a.ts b/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const seenInputs: CliInput[] = [];
    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({ kind: "pager", options: { noReview: false } }),
      readStdinLines: () => lineSourceFromString(stdin),
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
      loadAppBootstrapImpl: async (input) => {
        seenInputs.push(input);
        return createBootstrap(input);
      },
      usesPipedPatchInputImpl: () => false,
    });

    expect(plan.kind).toBe("app");
    if (plan.kind !== "app") throw new Error("Expected app startup plan.");
    expect(plan.cliInput.options.noReview).toBeUndefined();
    expect(plan.bootstrap.stream).toBeUndefined();
    expect(seenInputs).toHaveLength(1);
  });

  test("rejects watch mode for stdin-backed patch inputs", async () => {
    const cliInput: CliInput = {
      kind: "patch",
      file: "-",
      options: {
        watch: true,
      },
    };

    await expect(
      prepareStartupPlan(["bun", "hunk", "patch", "-", "--watch"], {
        parseCliImpl: async () => cliInput as ParsedCliInput,
        resolveRuntimeCliInputImpl: (input) => input,
        resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
      }),
    ).rejects.toBeInstanceOf(HunkUserError);
  });

  test("opens the controlling terminal for piped patch startup", async () => {
    const cliInput: CliInput = {
      kind: "patch",
      file: "-",
      options: {
        mode: "auto",
        pager: true,
      },
    };
    const controllingTerminal = { stdin: {} as never, stdout: {} as never, close: () => {} };
    let opened = 0;

    const plan = await prepareStartupPlan(["bun", "hunk", "patch", "-"], {
      parseCliImpl: async () => cliInput as ParsedCliInput,
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
      loadAppBootstrapImpl: async (input) => createBootstrap(input),
      usesPipedPatchInputImpl: (input) => {
        expect(input).toBe(cliInput);
        return true;
      },
      openControllingTerminalImpl: () => {
        opened += 1;
        return controllingTerminal;
      },
    });

    expect(plan).toMatchObject({
      kind: "app",
      cliInput,
      controllingTerminal,
    });
    expect(opened).toBe(1);
  });
});
