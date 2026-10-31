import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness, sleep } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

/** Hunk leaves the alternate screen only when it really exits. */
const LEAVE_ALTERNATE_SCREEN = "\x1b[?1049l";
const QUIT_PROMPT = /Quit review\?/;
const NOTE_TEXT = "Keep this review note.";

type Session = Awaited<ReturnType<typeof harness.launchHunk>>;

async function launchReview(configHome: string, extraArgs: string[] = []) {
  const fixture = harness.createAgentFilePair();
  const session = await harness.launchHunk({
    args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split", ...extraArgs],
    cols: 140,
    rows: 24,
    env: { XDG_CONFIG_HOME: configHome },
  });
  await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
  return { fixture, session };
}

async function openDraft(session: Session) {
  await harness.pressAndWaitForText(session, "c", /Draft note/, { timeout: 5_000 });
  await session.type(NOTE_TEXT);
  await session.waitForText(NOTE_TEXT, { timeout: 5_000 });
}

async function saveNote(session: Session) {
  await openDraft(session);
  await harness.pressAndWaitForText(session, ["ctrl", "s"], /Your note/, { timeout: 5_000 });
}

async function askToQuit(session: Session) {
  return harness.pressAndWaitForText(session, "q", QUIT_PROMPT, { timeout: 5_000 });
}

async function dismissPrompt(session: Session, key: "escape" | "n") {
  return harness.pressAndWaitForSnapshot(session, key, (text) => !QUIT_PROMPT.test(text), 5_000);
}

async function expectExitOn(session: Session, key: "enter" | "q" | "y") {
  const outputStart = session.getRawOutput().length;
  await session.press(key);
  await harness.waitForSnapshot(
    session,
    () => session.getRawOutput().slice(outputStart).includes(LEAVE_ALTERNATE_SCREEN),
    5_000,
  );
}

describe("PTY quit confirmation", () => {
  test("a saved note survives cancelling, ignores other keys, and y quits", async () => {
    const { session } = await launchReview(harness.createIsolatedConfigHome());

    try {
      await saveNote(session);

      await askToQuit(session);
      expect(await dismissPrompt(session, "escape")).toContain(NOTE_TEXT);

      await askToQuit(session);
      expect(await dismissPrompt(session, "n")).toContain(NOTE_TEXT);

      await askToQuit(session);
      await session.press("t");
      await session.press("q");
      await sleep(200);
      const held = await session.text({ immediate: true });
      expect(held).toMatch(QUIT_PROMPT);
      expect(held).not.toContain("Theme selector");

      await expectExitOn(session, "y");
    } finally {
      session.close();
    }
  });

  test("an open draft survives cancelling and enter quits", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
      env: { XDG_CONFIG_HOME: harness.createIsolatedConfigHome() },
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await openDraft(session);
      // A click in the sidebar moves focus off the composer, so q is a command again.
      await session.click(/M\s+\S+\.ts/, { first: true });

      await askToQuit(session);
      expect(await dismissPrompt(session, "escape")).toContain(NOTE_TEXT);

      await askToQuit(session);
      await expectExitOn(session, "enter");
    } finally {
      session.close();
    }
  });

  test("changed view preferences prompt after the confirmation and keep the review on cancel", async () => {
    const { session } = await launchReview(harness.createIsolatedConfigHome());

    try {
      await harness.pressAndWaitForText(session, "t", /Theme selector/, { timeout: 5_000 });
      await session.press("down");
      await harness.pressAndWaitForSnapshot(
        session,
        "enter",
        (text) => !text.includes("Theme selector"),
        5_000,
      );
      await saveNote(session);

      await askToQuit(session);
      await harness.pressAndWaitForText(session, "enter", /Save view preferences\?/, {
        timeout: 5_000,
      });
      const backInReview = await harness.pressAndWaitForSnapshot(
        session,
        "escape",
        (text) => !text.includes("Save view preferences?"),
        5_000,
      );
      expect(backInReview).toContain(NOTE_TEXT);

      await askToQuit(session);
      await harness.pressAndWaitForText(session, "enter", /Save view preferences\?/, {
        timeout: 5_000,
      });
      await expectExitOn(session, "q");
    } finally {
      session.close();
    }
  });

  test("an empty review quits without asking", async () => {
    const { session } = await launchReview(harness.createIsolatedConfigHome());

    try {
      await expectExitOn(session, "q");
    } finally {
      session.close();
    }
  });

  test("persisted agent notes alone quit without asking", async () => {
    const fixture = harness.createAgentFilePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--files",
        fixture.before,
        fixture.after,
        "--mode",
        "split",
        "--agent-context",
        fixture.agentContext,
      ],
      cols: 140,
      rows: 24,
      env: { XDG_CONFIG_HOME: harness.createIsolatedConfigHome() },
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await expectExitOn(session, "q");
    } finally {
      session.close();
    }
  });
});
