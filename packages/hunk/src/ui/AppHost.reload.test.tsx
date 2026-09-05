import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { SESSION_BROKER_REGISTRATION_VERSION } from "@hunk/session-broker-core";
import { removeTestDirectory } from "../../../../test/helpers/filesystem";
import type { HunkSessionBrokerClient } from "../session/broker/brokerClient";
import type {
  HunkSessionRegistration,
  HunkSessionServerMessage,
  HunkSessionSnapshot,
} from "../session/types";

const { getBundledVcsCatalog } = await import("../app/vcsCatalog");
const { loadAppBootstrap } = await import("../core/changeset/loaders");
const { AppHost } = await import("./AppHost");

/** Stand in for the session daemon so a test can send the commands agents send. */
function createTestHostClient() {
  type Bridge = Parameters<HunkSessionBrokerClient["setBridge"]>[0];

  let bridge: Bridge = null;
  let registration: HunkSessionRegistration = {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: "session-1",
    pid: process.pid,
    cwd: process.cwd(),
    repoRoot: process.cwd(),
    launchedAt: "2026-03-24T00:00:00.000Z",
    info: { inputKind: "diff", title: "before.ts → after.ts", sourceLabel: "after.ts", files: [] },
  };

  return {
    hostClient: {
      getRegistration: () => registration,
      replaceSession: (nextRegistration: HunkSessionRegistration) => {
        registration = nextRegistration;
      },
      setBridge: (nextBridge: Bridge) => {
        bridge = nextBridge;
      },
      updateSnapshot: (_snapshot: HunkSessionSnapshot) => {},
    } as unknown as HunkSessionBrokerClient,
    dispatchCommand: async (message: HunkSessionServerMessage) => {
      if (!bridge) {
        throw new Error("Expected App to register a bridge before running the test command.");
      }

      return bridge.dispatchCommand(message);
    },
  };
}

/**
 * Return the backgrounds painted behind `marked` and behind the rest of its rendered line.
 *
 * An attention mark is only visible as a background the surrounding code does not share, so
 * comparing the two is how a test sees the mark that character frames cannot show.
 */
function markedLineBackgrounds(
  frame: ReturnType<Awaited<ReturnType<typeof testRender>>["captureSpans"]>,
  lineText: string,
  marked: string,
) {
  const line = frame.lines.find((candidate) =>
    candidate.spans
      .map((span) => span.text)
      .join("")
      .includes(lineText),
  );
  const spans = line?.spans ?? [];
  const renderedText = spans.map((span) => span.text).join("");
  const markStart = renderedText.indexOf(marked, renderedText.indexOf(lineText));
  const markEnd = markStart + marked.length;

  const markedBackgrounds = new Set<string>();
  const unmarkedBackgrounds = new Set<string>();
  let offset = 0;
  for (const span of spans) {
    const spanEnd = offset + span.text.length;
    const overlapsMark = markStart >= 0 && offset < markEnd && spanEnd > markStart;
    (overlapsMark ? markedBackgrounds : unmarkedBackgrounds).add(JSON.stringify(span.bg ?? null));
    offset = spanEnd;
  }

  return { markedBackgrounds, unmarkedBackgrounds };
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Settle renders long enough for the async syntax-highlight cache to populate.
 *  Without this, the plain-text fallback path masks the stale-cache bug. */
async function settleHighlights(setup: Awaited<ReturnType<typeof testRender>>) {
  for (let i = 0; i < 15; i++) {
    await flush(setup);
    await Bun.sleep(50);
  }
}

describe("reload watch runtime compatibility", () => {
  test("refuses a live reload that enables watch mode under an affected Bun runtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-reload-watch-runtime-"));
    const file = join(dir, "test.txt");

    execSync("git init && git config user.email test@test && git config user.name test", {
      cwd: dir,
      stdio: "ignore",
    });
    writeFileSync(file, "original line\n");
    execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });
    writeFileSync(file, "original line\nfirst change\n");

    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "stack", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );
    const { dispatchCommand, hostClient } = createTestHostClient();
    const setup = await testRender(
      <AppHost bootstrap={bootstrap} hostClient={hostClient} bunVersion="1.3.10" />,
      { width: 120, height: 20 },
    );

    try {
      await flush(setup);

      await expect(
        dispatchCommand({
          type: "command",
          requestId: "reload-watch-runtime",
          command: "reload_session",
          input: {
            sessionId: "session-1",
            nextInput: {
              kind: "vcs",
              staged: false,
              options: { mode: "stack", excludeUntracked: true, watch: true },
            },
          },
        }),
      ).rejects.toThrow("can deadlock while closing filesystem watchers");

      await flush(setup);
      expect(setup.captureCharFrame()).toContain("first change");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });
});

describe("reload stale highlight cache", () => {
  test("r key picks up new file content for file-pair diffs", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".hunk-reload-file-"));
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");

    writeFileSync(left, "export const answer = 41;\n");
    writeFileSync(right, "export const answer = 42;\nexport const first = true;\n");

    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: { mode: "stack" },
    });

    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 220,
      height: 20,
    });

    try {
      await settleHighlights(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("first");

      // Modify the right file while hunk is open
      writeFileSync(right, "export const answer = 42;\nexport const second = true;\n");

      await act(async () => {
        await setup.mockInput.typeText("r");
      });

      let refreshed = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("second") && !frame.includes("first")) {
          refreshed = true;
          break;
        }
        await Bun.sleep(50);
      }

      expect(refreshed).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });

  test("r key picks up new file content for git working tree diffs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-reload-git-"));
    const file = join(dir, "test.txt");

    execSync("git init && git config user.email test@test && git config user.name test", {
      cwd: dir,
      stdio: "ignore",
    });
    writeFileSync(file, "original line\n");
    execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });

    writeFileSync(file, "original line\nfirst change\n");

    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "stack", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );

    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 120,
      height: 20,
    });

    try {
      await settleHighlights(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("first change");

      writeFileSync(file, "original line\nsecond change\n");

      await act(async () => {
        await setup.mockInput.typeText("r");
      });

      let refreshed = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("second change") && !frame.includes("first change")) {
          refreshed = true;
          break;
        }
        await Bun.sleep(50);
      }

      expect(refreshed).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });
});

describe("reload agent attention marks", () => {
  test("r key keeps agent attention marks when nothing changed on disk", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".hunk-reload-marks-"));
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");

    writeFileSync(left, "export const answer = 41;\n");
    writeFileSync(right, "export const answer = 42;\n");

    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: { mode: "stack" },
    });
    const { dispatchCommand, hostClient } = createTestHostClient();
    const setup = await testRender(<AppHost bootstrap={bootstrap} hostClient={hostClient} />, {
      width: 120,
      height: 20,
    });

    try {
      await flush(setup);

      await act(async () => {
        await dispatchCommand({
          type: "command",
          requestId: "highlight-1",
          command: "highlight",
          input: {
            sessionId: "session-1",
            filePath: "after.ts",
            side: "new",
            line: 1,
            start: 13,
            end: 19,
            tone: "current",
            reveal: true,
          },
        });
      });
      await flush(setup);
      const painted = markedLineBackgrounds(
        setup.captureSpans(),
        "export const answer = 42",
        "answer",
      );
      expect(painted.markedBackgrounds.size).toBe(1);
      expect(painted.unmarkedBackgrounds).not.toContain([...painted.markedBackgrounds][0]!);

      // Refresh with nothing changed on disk: the review is rebuilt, the marked line is not.
      await act(async () => {
        await setup.mockInput.typeText("r");
        await Bun.sleep(120);
        await setup.renderOnce();
      });
      await flush(setup);

      const repainted = markedLineBackgrounds(
        setup.captureSpans(),
        "export const answer = 42",
        "answer",
      );
      expect([...repainted.markedBackgrounds]).toEqual([...painted.markedBackgrounds]);
      expect(repainted.unmarkedBackgrounds).not.toContain([...repainted.markedBackgrounds][0]!);

      const cleared = await act(async () =>
        dispatchCommand({
          type: "command",
          requestId: "clear-1",
          command: "clear_highlights",
          input: { sessionId: "session-1" },
        }),
      );
      expect(cleared).toMatchObject({ removedCount: 1, remainingCount: 0 });
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });

  test("r key keeps marks painted on an unchanged file whose runtime id shifts", async () => {
    // VCS file ids embed the file's index in the changeset, so an unrelated file joining
    // the review gives an untouched file a brand-new runtime id. The carried mark is
    // re-keyed onto that id and must still reach paint: a paint path that trusted the
    // previous file identity instead of the re-keyed id would silently drop it here.
    const dir = mkdtempSync(join(tmpdir(), "hunk-reload-marks-shift-"));
    const alpha = join(dir, "alpha.ts");
    const bravo = join(dir, "bravo.ts");

    execSync("git init && git config user.email test@test && git config user.name test", {
      cwd: dir,
      stdio: "ignore",
    });
    writeFileSync(alpha, "export const alpha = 1;\n");
    writeFileSync(bravo, "export const bravo = 1;\n");
    execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });

    // Only bravo starts out changed, so it is the changeset's first (index 0) file.
    writeFileSync(bravo, "export const bravo = 2;\n");

    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "stack", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );
    const { dispatchCommand, hostClient } = createTestHostClient();
    const setup = await testRender(<AppHost bootstrap={bootstrap} hostClient={hostClient} />, {
      width: 120,
      height: 40,
    });

    try {
      await flush(setup);

      await act(async () => {
        await dispatchCommand({
          type: "command",
          requestId: "highlight-1",
          command: "highlight",
          input: {
            sessionId: "session-1",
            filePath: "bravo.ts",
            side: "new",
            line: 1,
            start: 13,
            end: 18,
            tone: "current",
          },
        });
      });
      await flush(setup);
      const painted = markedLineBackgrounds(
        setup.captureSpans(),
        "export const bravo = 2",
        "bravo",
      );
      expect(painted.markedBackgrounds.size).toBe(1);
      expect(painted.unmarkedBackgrounds).not.toContain([...painted.markedBackgrounds][0]!);

      // Change alpha only: after reload the changeset is [alpha, bravo], so bravo keeps
      // its content but not its runtime id.
      writeFileSync(alpha, "export const alpha = 100;\n");
      await act(async () => {
        await setup.mockInput.typeText("r");
      });

      let reloaded = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await flush(setup);
        if (setup.captureCharFrame().includes("export const alpha = 100")) {
          reloaded = true;
          break;
        }
        await Bun.sleep(50);
      }
      expect(reloaded).toBe(true);

      const repainted = markedLineBackgrounds(
        setup.captureSpans(),
        "export const bravo = 2",
        "bravo",
      );
      expect([...repainted.markedBackgrounds]).toEqual([...painted.markedBackgrounds]);
      expect(repainted.unmarkedBackgrounds).not.toContain([...repainted.markedBackgrounds][0]!);

      // The carried mark still answers to clear, so it is live state, not a paint ghost.
      const cleared = await act(async () =>
        dispatchCommand({
          type: "command",
          requestId: "clear-2",
          command: "clear_highlights",
          input: { sessionId: "session-1" },
        }),
      );
      expect(cleared).toMatchObject({ removedCount: 1, remainingCount: 0 });
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });
});
