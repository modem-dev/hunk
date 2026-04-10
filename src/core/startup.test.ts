import { describe, expect, test } from "bun:test";
import { HunkUserError } from "./errors";
import { prepareStartupPlan } from "./startup";
import type { AppBootstrap, CliInput, ParsedCliInput } from "./types";

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
  test("defaults bare interactive invocations to working-tree diff startup", async () => {
    const seenInputs: CliInput[] = [];

    const plan = await prepareStartupPlan(["bun", "hunk"], {
      parseCliImpl: async () => ({ kind: "bare" }),
      stdinIsTTY: true,
      resolveRuntimeCliInputImpl(input) {
        seenInputs.push(input);
        return input;
      },
      resolveConfiguredCliInputImpl(input) {
        seenInputs.push(input);
        return { input } as never;
      },
      loadAppBootstrapImpl: async (input) => {
        seenInputs.push(input);
        return createBootstrap(input);
      },
      usesPipedPatchInputImpl: () => false,
    });

    expect(plan.kind).toBe("app");
    if (plan.kind !== "app") {
      throw new Error("Expected app startup plan.");
    }

    expect(plan.cliInput).toEqual({
      kind: "git",
      staged: false,
      options: {},
    });
    expect(seenInputs).toHaveLength(3);
  });

  test("returns help output for explicit --help without entering app startup", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk", "--help"], {
      parseCliImpl: async () => ({ kind: "help", text: "Usage: hunk\n" }),
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "help", text: "Usage: hunk\n" });
    expect(loaded).toBe(false);
  });

  test("keeps bare non-interactive invocation on help when stdin is empty", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk"], {
      parseCliImpl: async () => ({ kind: "bare" }),
      stdinIsTTY: false,
      readStdinText: async () => "",
      looksLikePatchInputImpl: () => false,
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") {
      throw new Error("Expected help output.");
    }
    expect(plan.text).toContain("Usage:");
    expect(loaded).toBe(false);
  });

  test("passes the MCP serve command through without app bootstrap work", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk", "mcp", "serve"], {
      parseCliImpl: async () => ({ kind: "mcp-serve" }),
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "mcp-serve" });
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
      readStdinText: async () => "* main\n  feature/demo\n",
      looksLikePatchInputImpl: () => false,
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "plain-text-pager", text: "* main\n  feature/demo\n" });
    expect(loaded).toBe(false);
  });

  test("normalizes diff-like pager stdin into patch app startup", async () => {
    const seenInputs: CliInput[] = [];

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({ kind: "pager", options: { theme: "paper" } }),
      readStdinText: async () => "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      looksLikePatchInputImpl: () => true,
      resolveRuntimeCliInputImpl(input) {
        seenInputs.push(input);
        return input;
      },
      resolveConfiguredCliInputImpl(input) {
        seenInputs.push(input);
        return { input } as never;
      },
      loadAppBootstrapImpl: async (input) => {
        seenInputs.push(input);
        return createBootstrap(input);
      },
      usesPipedPatchInputImpl: () => false,
    });

    expect(plan.kind).toBe("app");
    if (plan.kind !== "app") {
      throw new Error("Expected app startup plan.");
    }

    expect(plan.cliInput).toMatchObject({
      kind: "patch",
      file: "-",
      text: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      options: {
        theme: "paper",
        pager: true,
      },
    });
    expect(seenInputs).toHaveLength(3);
  });

  test("normalizes bare non-interactive diff stdin into patch app startup", async () => {
    const seenInputs: CliInput[] = [];

    const plan = await prepareStartupPlan(["bun", "hunk"], {
      parseCliImpl: async () => ({ kind: "bare" }),
      stdinIsTTY: false,
      readStdinText: async () => "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      looksLikePatchInputImpl: () => true,
      resolveRuntimeCliInputImpl(input) {
        seenInputs.push(input);
        return input;
      },
      resolveConfiguredCliInputImpl(input) {
        seenInputs.push(input);
        return { input } as never;
      },
      loadAppBootstrapImpl: async (input) => {
        seenInputs.push(input);
        return createBootstrap(input);
      },
      usesPipedPatchInputImpl: () => false,
    });

    expect(plan.kind).toBe("app");
    if (plan.kind !== "app") {
      throw new Error("Expected app startup plan.");
    }

    expect(plan.cliInput).toMatchObject({
      kind: "patch",
      file: "-",
      text: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      options: {
        pager: true,
      },
    });
    expect(seenInputs).toHaveLength(3);
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
