import { describe, expect, test } from "bun:test";
import type { FeedbackCommandInput } from "../run/commandInputs";
import {
  runFeedbackCommand,
  wrapFeedbackParagraph,
  type FeedbackCommandDeps,
} from "./runFeedbackCommand";
import type { FeedbackPayload } from "./payload";
import type { FeedbackSendResult } from "./send";

/** Build one parsed `hunk feedback` input. */
function createTestFeedbackInput(
  overrides: Partial<FeedbackCommandInput> = {},
): FeedbackCommandInput {
  return {
    kind: "feedback",
    message: "Split view loses my place",
    dryRun: false,
    skipConfirm: false,
    output: "text",
    ...overrides,
  };
}

/** Build command deps that record output, prompts, and every send without touching the network. */
function createTestFeedbackDeps(
  overrides: Partial<FeedbackCommandDeps> = {},
  result: FeedbackSendResult = { kind: "sent", id: "evt_1" },
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const questions: string[] = [];
  const sent: FeedbackPayload[] = [];
  let sendLoads = 0;
  const deps: FeedbackCommandDeps = {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    feedbackEnabled: true,
    environment: { version: "0.24.1", platform: "darwin" },
    createSubmissionId: () => "0192e2f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
    confirm: async (question) => {
      questions.push(question);
      return true;
    },
    loadSend: async () => {
      sendLoads += 1;
      return async (payload) => {
        sent.push(payload);
        return result;
      };
    },
    ...overrides,
  };

  return {
    deps,
    stdout,
    stderr,
    questions,
    sent,
    get sendLoads() {
      return sendLoads;
    },
  };
}

describe("hunk feedback: nothing is sent before consent", () => {
  test("a declined prompt sends nothing and never loads the send module", async () => {
    const run = createTestFeedbackDeps({ confirm: async () => false });

    expect(await runFeedbackCommand(createTestFeedbackInput(), run.deps)).toBe(0);
    expect(run.sendLoads).toBe(0);
    expect(run.stdout.join("")).toBe("Not sent.\n");
  });

  test("--dry-run prints the exact body and sends nothing", async () => {
    const run = createTestFeedbackDeps();

    expect(await runFeedbackCommand(createTestFeedbackInput({ dryRun: true }), run.deps)).toBe(0);
    expect(run.sendLoads).toBe(0);
    expect(run.questions).toHaveLength(0);
    expect(run.stdout.join("")).toContain('"message": "Split view loses my place"');
    expect(run.stdout.join("")).toContain("Dry run: nothing was sent.");
  });

  test("--dry-run without a message refuses instead of opening the form", async () => {
    let formOpened = false;
    const run = createTestFeedbackDeps({
      openForm: async () => {
        formOpened = true;
        return 0;
      },
    });

    expect(
      await runFeedbackCommand(
        createTestFeedbackInput({ message: undefined, dryRun: true }),
        run.deps,
      ),
    ).toBe(2);
    expect(formOpened).toBe(false);
    expect(run.sendLoads).toBe(0);
  });

  test("a run with no terminal to confirm on refuses without --skip-confirm", async () => {
    const run = createTestFeedbackDeps({ confirm: undefined });

    expect(await runFeedbackCommand(createTestFeedbackInput(), run.deps)).toBe(2);
    expect(run.sendLoads).toBe(0);
    expect(run.stderr.join("")).toContain("pass --skip-confirm");
  });

  test("an invalid draft fails before any prompt", async () => {
    const run = createTestFeedbackDeps();

    expect(await runFeedbackCommand(createTestFeedbackInput({ message: "   " }), run.deps)).toBe(2);
    expect(await runFeedbackCommand(createTestFeedbackInput({ email: "nope" }), run.deps)).toBe(2);
    expect(run.questions).toHaveLength(0);
    expect(run.sendLoads).toBe(0);
  });

  test("[feedback] enabled = false refuses before reading anything", async () => {
    let read = false;
    const run = createTestFeedbackDeps({
      feedbackEnabled: false,
      readStdin: async () => {
        read = true;
        return "hi";
      },
    });

    expect(
      await runFeedbackCommand(
        createTestFeedbackInput({ file: "-", message: undefined }),
        run.deps,
      ),
    ).toBe(2);
    expect(read).toBe(false);
    expect(run.sendLoads).toBe(0);
  });
});

describe("hunk feedback: sending", () => {
  test("sends exactly the previewed body once after `y`", async () => {
    const run = createTestFeedbackDeps();

    expect(
      await runFeedbackCommand(createTestFeedbackInput({ email: "ada@example.com" }), run.deps),
    ).toBe(0);
    expect(run.questions).toEqual(["Send this feedback to Modem? [y/N] "]);
    expect(run.sent).toEqual([
      {
        submission_id: "0192e2f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
        message: "Split view loses my place",
        source: "tui",
        release: "0.24.1",
        tags: { category: "user_feedback", os: "darwin", surface: "cli" },
        email: "ada@example.com",
      },
    ]);
    expect(run.stderr.join("")).toContain("the email address you entered");
    expect(run.stdout.join("")).toBe("Sent. Thanks! Reference: evt_1\n");
  });

  test("--skip-confirm skips only the prompt; the disclosure still prints", async () => {
    const run = createTestFeedbackDeps({ confirm: undefined });

    expect(await runFeedbackCommand(createTestFeedbackInput({ skipConfirm: true }), run.deps)).toBe(
      0,
    );
    expect(run.sent).toHaveLength(1);
    expect(run.stderr.join("")).toContain("This sends your message to the Modem team");
    expect(run.stderr.join("")).toContain("Request body:");
  });

  test("a piped message is confirmed through the terminal prompt, not stdin", async () => {
    const run = createTestFeedbackDeps({ readStdin: async () => "y\n" });
    run.deps.confirm = async (question) => {
      run.questions.push(question);
      return false;
    };

    expect(
      await runFeedbackCommand(
        createTestFeedbackInput({ message: undefined, file: "-" }),
        run.deps,
      ),
    ).toBe(0);
    expect(run.questions).toHaveLength(1);
    expect(run.sent).toHaveLength(0);
  });

  test("reports an unconfirmed send with its submission ID and exit 1", async () => {
    const run = createTestFeedbackDeps(
      {},
      { kind: "unconfirmed", message: "It may have arrived." },
    );

    expect(await runFeedbackCommand(createTestFeedbackInput({ output: "json" }), run.deps)).toBe(1);
    expect(JSON.parse(run.stdout.join(""))).toEqual({
      sent: false,
      reason: "unconfirmed",
      message: "It may have arrived.",
      submission_id: "0192e2f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
    });
  });

  test("opens the form when no message is given and a terminal is available", async () => {
    const run = createTestFeedbackDeps({ openForm: async () => 0 });

    expect(
      await runFeedbackCommand(createTestFeedbackInput({ message: undefined }), run.deps),
    ).toBe(0);
    expect(run.sendLoads).toBe(0);
  });

  test("refuses with no message and no terminal", async () => {
    const run = createTestFeedbackDeps();

    expect(
      await runFeedbackCommand(createTestFeedbackInput({ message: undefined }), run.deps),
    ).toBe(2);
  });
});

describe("hunk feedback: preview layout", () => {
  test("wraps the disclosure at word boundaries instead of the terminal edge", () => {
    expect(wrapFeedbackParagraph("one two three four", 9)).toBe("one two\nthree\nfour");
    expect(wrapFeedbackParagraph("supercalifragilistic word", 5)).toBe(
      "supercalifragilistic\nword",
    );
  });

  test("keeps every preview line within the wrap width outside the JSON body", async () => {
    const run = createTestFeedbackDeps({ wrapWidth: 60 });

    await runFeedbackCommand(createTestFeedbackInput({ dryRun: true }), run.deps);
    const disclosure = run.stdout.join("").split("Request body:")[0]!;
    expect(disclosure.split("\n").every((line) => line.length <= 60)).toBe(true);
  });
});
