import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import type { UserNoteLineTarget } from "../../core/liveComments";
import type { LineCursor } from "../lib/lineCursors";
import type { DraftReviewNote, UserReviewNote } from "../lib/reviewNoteMapping";
import {
  projectExtensionReviewNote,
  useUserNoteComposer,
  type UseUserNoteComposerOptions,
} from "./useUserNoteComposer";

const draftNote: DraftReviewNote = {
  id: "draft:alpha:1",
  fileId: "runtime-alpha",
  filePath: "src/alpha.ts",
  hunkIndex: 1,
  side: "new",
  line: 42,
  body: "initial body",
};

const savedNote: UserReviewNote = {
  id: "user:stable-1",
  source: "user",
  filePath: "src/alpha.ts",
  hunkIndex: 1,
  side: "new",
  line: 42,
  summary: "saved body",
  author: "user",
  createdAt: "2026-01-02T03:04:05.000Z",
  editable: true,
};

/** Build a measured current-line cursor for note targeting tests. */
function lineCursor(fileId: string, hunkIndex: number, target: UserNoteLineTarget): LineCursor {
  return { fileId, hunkIndex, stableKey: `${fileId}:${hunkIndex}`, target };
}

/** Mount the composer with replaceable inputs and expose its latest committed result. */
async function renderComposer(options: UseUserNoteComposerOptions) {
  let composer!: ReturnType<typeof useUserNoteComposer>;
  let replaceOptions!: (next: UseUserNoteComposerOptions) => void;

  function Harness() {
    const [currentOptions, setCurrentOptions] = useState(options);
    replaceOptions = setCurrentOptions;
    composer = useUserNoteComposer(currentOptions);
    return null;
  }

  const setup = await testRender(<Harness />, { width: 20, height: 4 });
  await act(async () => setup.renderOnce());
  return {
    setup,
    composer: () => composer,
    replaceOptions: (next: UseUserNoteComposerOptions) => replaceOptions(next),
  };
}

/** Build the inert semantic actions and focus seams each focused test overrides. */
function baseOptions(
  overrides: Partial<UseUserNoteComposerOptions> = {},
): UseUserNoteComposerOptions {
  return {
    draftNote: null,
    keyboardCursorEnabled: true,
    getLineCursor: () => null,
    startDraft: () => null,
    updateDraft: () => {},
    saveDraft: () => null,
    cancelDraft: () => {},
    focus: { draft: () => {}, review: () => {}, blurDraft: () => {} },
    publishEvent: () => {},
    ...overrides,
  };
}

describe("useUserNoteComposer", () => {
  test("prefers explicit targets, then hover, then the enabled keyboard cursor", async () => {
    const starts: Parameters<UseUserNoteComposerOptions["startDraft"]>[] = [];
    let cursorReads = 0;
    const cursor = lineCursor("cursor-file", 4, { side: "old", line: 18 });
    const harness = await renderComposer(
      baseOptions({
        getLineCursor: () => {
          cursorReads += 1;
          return cursor;
        },
        startDraft: (...args) => {
          starts.push(args);
          return draftNote;
        },
      }),
    );

    try {
      await act(async () => {
        harness.composer().onActiveAddNoteAffordanceChange({
          fileId: "hover-file",
          hunkIndex: 3,
          target: { side: "new", line: 31 },
        });
      });
      await act(async () => setupRender(harness.setup));

      await act(async () => harness.composer().startUserNote());
      expect(starts[0]).toEqual([
        "hover-file",
        3,
        { side: "new", line: 31 },
        { preserveViewport: true },
      ]);
      expect(cursorReads).toBe(0);

      await act(async () => {
        harness.composer().onActiveAddNoteAffordanceChange({
          fileId: "stale-hover-file",
          hunkIndex: 9,
          target: { side: "new", line: 99 },
        });
      });
      await act(async () => setupRender(harness.setup));
      const explicitTarget = { side: "old", line: 7 } as const;
      await act(async () => harness.composer().startUserNote(undefined, undefined, explicitTarget));
      expect(starts[1]).toEqual([undefined, undefined, explicitTarget, { preserveViewport: true }]);
      expect(cursorReads).toBe(0);

      // The successful implicit start cleared the hover affordance, so the next
      // implicit start falls through to the measured keyboard cursor.
      await act(async () => setupRender(harness.setup));
      await act(async () => harness.composer().startUserNote());
      expect(starts[2]).toEqual([
        "cursor-file",
        4,
        { side: "old", line: 18 },
        { preserveViewport: true },
      ]);
      expect(cursorReads).toBe(1);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("does not consult the current line when cursor navigation is off", async () => {
    let cursorReads = 0;
    let startArgs: Parameters<UseUserNoteComposerOptions["startDraft"]> | undefined;
    const harness = await renderComposer(
      baseOptions({
        keyboardCursorEnabled: false,
        getLineCursor: () => {
          cursorReads += 1;
          return lineCursor("cursor-file", 0, { side: "new", line: 1 });
        },
        startDraft: (...args) => {
          startArgs = args;
          return null;
        },
      }),
    );

    try {
      await act(async () => harness.composer().startUserNote());
      expect(cursorReads).toBe(0);
      expect(startArgs).toEqual([undefined, undefined, undefined, { preserveViewport: false }]);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("failed draft creation preserves the hover affordance and does not steal focus", async () => {
    const targets: Array<string | undefined> = [];
    let draftFocusCount = 0;
    const harness = await renderComposer(
      baseOptions({
        startDraft: (fileId) => {
          targets.push(fileId);
          return null;
        },
        focus: {
          draft: () => {
            draftFocusCount += 1;
          },
          review: () => {},
          blurDraft: () => {},
        },
      }),
    );

    try {
      await act(async () => {
        harness.composer().onActiveAddNoteAffordanceChange({
          fileId: "hover-file",
          hunkIndex: 0,
        });
      });
      await act(async () => setupRender(harness.setup));
      await act(async () => harness.composer().startUserNote());
      await act(async () => harness.composer().startUserNote());

      expect(targets).toEqual(["hover-file", "hover-file"]);
      expect(draftFocusCount).toBe(0);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("forwards mouse viewport policy through edit and reply composer wrappers", async () => {
    const editStarts: unknown[][] = [];
    const replyStarts: unknown[][] = [];
    let draftFocusCount = 0;
    const harness = await renderComposer(
      baseOptions({
        startEdit: (...args) => {
          editStarts.push(args);
          return draftNote;
        },
        startReply: (...args) => {
          replyStarts.push(args);
          return draftNote;
        },
        focus: {
          draft: () => {
            draftFocusCount += 1;
          },
          review: () => {},
          blurDraft: () => {},
        },
      }),
    );

    try {
      await act(async () =>
        harness.composer().startUserNoteEdit("edit-note", { preserveViewport: true }),
      );
      await act(async () =>
        harness.composer().startUserNoteReply("reply-note", { preserveViewport: true }),
      );

      expect(editStarts).toEqual([["edit-note", { preserveViewport: true }]]);
      expect(replyStarts).toEqual([["reply-note", { preserveViewport: true }]]);
      expect(draftFocusCount).toBe(2);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("coordinates focus, cancel, and blur transitions through narrow actions", async () => {
    const transitions: string[] = [];
    let cancelCount = 0;
    const harness = await renderComposer(
      baseOptions({
        cancelDraft: () => {
          cancelCount += 1;
        },
        focus: {
          draft: () => transitions.push("draft"),
          review: () => transitions.push("review"),
          blurDraft: () => transitions.push("blur"),
        },
      }),
    );

    try {
      await act(async () => harness.composer().focusDraftNote());
      await act(async () => harness.composer().blurDraftNote());
      await act(async () => harness.composer().cancelDraftNote());

      expect(transitions).toEqual(["draft", "blur", "review"]);
      expect(cancelCount).toBe(1);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("publishes one created event with the prior draft file id and saved identity", async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    let saveCount = 0;
    let reviewFocusCount = 0;
    const harness = await renderComposer(
      baseOptions({
        draftNote,
        saveDraft: () => (++saveCount === 1 ? savedNote : null),
        focus: {
          draft: () => {},
          review: () => {
            reviewFocusCount += 1;
          },
          blurDraft: () => {},
        },
        publishEvent: (event, payload) => events.push({ event, payload }),
      }),
    );

    try {
      // A repeated save before React commits still publishes only the semantic
      // creation that actually succeeded.
      await act(async () => {
        harness.composer().saveDraftNote();
        harness.composer().saveDraftNote();
      });

      expect(events).toEqual([
        {
          event: "note_created",
          payload: {
            note: {
              id: "user:stable-1",
              fileId: "runtime-alpha",
              filePath: "src/alpha.ts",
              hunkIndex: 1,
              side: "new",
              line: 42,
              body: "saved body",
              draft: false,
            },
          },
        },
      ]);
      expect(reviewFocusCount).toBe(2);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("publishes a committed edit distinctly from note creation", async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const editDraft: DraftReviewNote = {
      ...draftNote,
      kind: "edit",
      targetNoteId: savedNote.id,
      body: savedNote.summary,
    };
    const harness = await renderComposer(
      baseOptions({
        draftNote: editDraft,
        saveDraft: () => savedNote,
        publishEvent: (event, payload) => events.push({ event, payload }),
      }),
    );

    try {
      await act(async () => harness.composer().saveDraftNote());
      expect(events).toEqual([
        {
          event: "note_edited",
          payload: {
            note: {
              id: savedNote.id,
              fileId: draftNote.fileId,
              filePath: savedNote.filePath,
              hunkIndex: savedNote.hunkIndex,
              side: savedNote.side,
              line: savedNote.line,
              body: savedNote.summary,
              draft: false,
            },
          },
        },
      ]);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("updates the semantic draft and publishes the editor's current body", async () => {
    const bodies: string[] = [];
    const events: Array<{ event: string; payload: unknown }> = [];
    const harness = await renderComposer(
      baseOptions({
        draftNote,
        updateDraft: (body) => bodies.push(body),
        publishEvent: (event, payload) => events.push({ event, payload }),
      }),
    );

    try {
      await act(async () => harness.composer().updateDraftNote("current editor body"));

      expect(bodies).toEqual(["current editor body"]);
      expect(events).toEqual([
        {
          event: "note_edited",
          payload: {
            note: {
              id: "draft:alpha:1",
              fileId: "runtime-alpha",
              filePath: "src/alpha.ts",
              hunkIndex: 1,
              side: "new",
              line: 42,
              body: "current editor body",
              draft: true,
            },
          },
        },
      ]);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("uses replacement draft facts and callbacks after a committed rerender", async () => {
    const staleCalls: string[] = [];
    const currentCalls: string[] = [];
    const currentEvents: Array<{ event: string; payload: unknown }> = [];
    const replacementDraft: DraftReviewNote = {
      ...draftNote,
      id: "draft:beta:2",
      fileId: "runtime-beta",
      filePath: "src/beta.ts",
      hunkIndex: 2,
      side: "old",
      line: 17,
      body: "replacement body",
    };
    const replacementSaved: UserReviewNote = {
      ...savedNote,
      id: "user:stable-2",
      filePath: "src/beta.ts",
      hunkIndex: 2,
      side: "old",
      line: 17,
      summary: "replacement saved body",
    };
    const harness = await renderComposer(
      baseOptions({
        draftNote,
        startDraft: () => {
          staleCalls.push("start");
          return draftNote;
        },
        updateDraft: () => staleCalls.push("update"),
        saveDraft: () => {
          staleCalls.push("save");
          return savedNote;
        },
        cancelDraft: () => staleCalls.push("cancel"),
        focus: {
          draft: () => staleCalls.push("focus:draft"),
          review: () => staleCalls.push("focus:review"),
          blurDraft: () => staleCalls.push("focus:blur"),
        },
        publishEvent: () => staleCalls.push("publish"),
      }),
    );

    try {
      await act(async () => {
        harness.replaceOptions(
          baseOptions({
            draftNote: replacementDraft,
            startDraft: () => {
              currentCalls.push("start");
              return replacementDraft;
            },
            updateDraft: () => currentCalls.push("update"),
            saveDraft: () => {
              currentCalls.push("save");
              return replacementSaved;
            },
            cancelDraft: () => currentCalls.push("cancel"),
            focus: {
              draft: () => currentCalls.push("focus:draft"),
              review: () => currentCalls.push("focus:review"),
              blurDraft: () => currentCalls.push("focus:blur"),
            },
            publishEvent: (event, payload) => currentEvents.push({ event, payload }),
          }),
        );
      });
      await act(async () => setupRender(harness.setup));

      await act(async () => {
        harness.composer().startUserNote("runtime-beta", 2, { side: "old", line: 17 });
        harness.composer().focusDraftNote();
        harness.composer().blurDraftNote();
        harness.composer().updateDraftNote("current replacement body");
        harness.composer().saveDraftNote();
        harness.composer().cancelDraftNote();
      });

      expect(staleCalls).toEqual([]);
      expect(currentCalls).toEqual([
        "start",
        "focus:draft",
        "focus:draft",
        "focus:blur",
        "update",
        "save",
        "focus:review",
        "cancel",
        "focus:review",
      ]);
      expect(currentEvents).toEqual([
        {
          event: "note_edited",
          payload: {
            note: {
              id: "draft:beta:2",
              fileId: "runtime-beta",
              filePath: "src/beta.ts",
              hunkIndex: 2,
              side: "old",
              line: 17,
              body: "current replacement body",
              draft: true,
            },
          },
        },
        {
          event: "note_created",
          payload: {
            note: {
              id: "user:stable-2",
              fileId: "runtime-beta",
              filePath: "src/beta.ts",
              hunkIndex: 2,
              side: "old",
              line: 17,
              body: "replacement saved body",
              draft: false,
            },
          },
        },
      ]);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });
});

describe("projectExtensionReviewNote", () => {
  test("projects draft bodies and saved summaries without changing ids or targets", () => {
    expect(projectExtensionReviewNote(draftNote, true)).toEqual({
      id: draftNote.id,
      fileId: draftNote.fileId,
      filePath: draftNote.filePath,
      hunkIndex: draftNote.hunkIndex,
      side: draftNote.side,
      line: draftNote.line,
      body: draftNote.body,
      draft: true,
    });
    expect(
      projectExtensionReviewNote(
        { ...savedNote, parentId: "user:parent", fileId: "runtime-alpha" },
        false,
      ),
    ).toEqual({
      id: savedNote.id,
      parentId: "user:parent",
      fileId: "runtime-alpha",
      filePath: savedNote.filePath,
      hunkIndex: savedNote.hunkIndex,
      side: savedNote.side,
      line: savedNote.line,
      body: savedNote.summary,
      draft: false,
    });
  });
});

/** Flush hook state updates through the OpenTUI React test renderer. */
async function setupRender(setup: Awaited<ReturnType<typeof testRender>>) {
  await setup.renderOnce();
}
