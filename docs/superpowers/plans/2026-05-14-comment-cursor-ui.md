# Comment cursor UI implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a keyboard-driven cursor that lets a developer attach a single-line review comment to any diff row from inside the Hunk TUI, reusing the existing `LiveComment` store so agents pick up user comments through the same `hunk session comment *` commands they already use.

**Architecture:** Cursor state lives in `useReviewController` next to the existing selection state. Cursor geometry is computed by a new pure helper module. The composer is mounted as a new planned-row kind that flows through the existing diff render plan, geometry layer, and row renderer. The user-authored `LiveComment` reuses every existing storage and render path with only `source: "user"` as the discriminator.

**Tech Stack:** Bun, React, OpenTUI (built-in `<input>` element only — no new packages), TypeScript, `@pierre/diffs`, `bun:test`, `tuistory` PTY harness.

**Source spec:** `docs/superpowers/specs/2026-05-14-comment-cursor-ui-design.md`

---

## Files

- Create: `src/ui/lib/commentCursor.ts` — pure cursor geometry helpers
- Create: `src/ui/lib/commentCursor.test.ts` — colocated unit tests for the helpers
- Create: `src/ui/components/panes/CommentComposer.tsx` — inline composer card
- Create: `test/pty/comment-cursor-integration.test.ts` — PTY-backed integration test
- Modify: `src/hunk-session/types.ts` — widen `LiveComment.source` to `"mcp" | "user"`
- Modify: `src/core/liveComments.ts` — add `buildUserLiveComment`
- Modify: `src/core/liveComments.test.ts` — extend coverage for the new builder
- Modify: `src/ui/hooks/useReviewController.ts` — own cursor state and `addUserLiveComment`
- Modify: `src/ui/hooks/useReviewController.test.tsx` — extend coverage for cursor state and `addUserLiveComment`
- Modify: `src/ui/diff/reviewRenderPlan.ts` — add the `comment-composer` planned row kind
- Modify: `src/ui/lib/diffSectionGeometry.ts` — measure composer row height
- Modify: `src/ui/diff/PierreDiffView.tsx` — accept cursor stable key, render the composer planned-row kind
- Modify: `src/ui/diff/renderRows.tsx` — apply cursor highlight when a row matches the cursor stable key
- Modify: `src/ui/components/panes/DiffPane.tsx` — accept and plumb cursor state
- Modify: `src/ui/components/panes/DiffSection.tsx` — accept and plumb cursor state
- Modify: `src/ui/hooks/useAppKeyboardShortcuts.ts` — new mode handler `handleCursorShortcut`
- Modify: `src/ui/App.tsx` — wire cursor state, pass to DiffPane and keyboard hook, add View menu entry
- Modify: `src/ui/lib/appMenus.ts` — add the `Toggle comment cursor (c)` View menu entry
- Modify: `src/ui/AppHost.interactions.test.tsx` — interaction coverage of the cursor flow
- Modify: `CHANGELOG.md` — record the user-visible addition

---

### Task 1: Widen `LiveComment.source`

**Files:**

- Modify: `src/hunk-session/types.ts`

- [ ] **Step 1: Widen the source union**

In `src/hunk-session/types.ts`, find:

```ts
export interface LiveComment extends AgentAnnotation {
  id: string;
  source: "mcp";
```

Change to:

```ts
export interface LiveComment extends AgentAnnotation {
  id: string;
  source: "mcp" | "user";
```

- [ ] **Step 2: Run typecheck to verify nothing else relied on the literal**

Run: `bun run typecheck`
Expected: PASS. Every existing call site sets `source: "mcp"`, which is still in the widened union.

- [ ] **Step 3: Run the full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/hunk-session/types.ts
git commit -m "refactor(types): widen LiveComment.source to accept user-authored comments"
```

---

### Task 2: Add `buildUserLiveComment`

**Files:**

- Modify: `src/core/liveComments.ts`
- Test: `src/core/liveComments.test.ts`

- [ ] **Step 1: Add the failing test**

In `src/core/liveComments.test.ts`, append inside the `describe("live comment helpers", ...)` block:

```ts
test("builds a live user comment annotation", () => {
  const comment = buildUserLiveComment(
    {
      filePath: "src/example.ts",
      side: "new",
      line: 4,
      summary: "Look at this addition",
      author: "andrew",
    },
    "user:test-1",
    "2026-05-14T00:00:00.000Z",
    0,
  );

  expect(comment).toMatchObject({
    id: "user:test-1",
    source: "user",
    author: "andrew",
    filePath: "src/example.ts",
    hunkIndex: 0,
    side: "new",
    line: 4,
    summary: "Look at this addition",
    newRange: [4, 4],
    tags: ["user"],
  });
  expect(comment.confidence).toBeUndefined();
});

test("builds an old-side user comment with an oldRange instead of newRange", () => {
  const comment = buildUserLiveComment(
    {
      filePath: "src/example.ts",
      side: "old",
      line: 2,
      summary: "Why was this removed?",
    },
    "user:test-2",
    "2026-05-14T00:00:00.000Z",
    0,
  );

  expect(comment).toMatchObject({
    source: "user",
    side: "old",
    line: 2,
    oldRange: [2, 2],
    tags: ["user"],
  });
  expect(comment.newRange).toBeUndefined();
});
```

Add the new import at the top of the file, replacing the existing `liveComments` import line:

```ts
import {
  buildLiveComment,
  buildUserLiveComment,
  findDiffFileByPath,
  findHunkIndexForLine,
  firstCommentTargetForHunk,
  hunkLineRange,
  resolveCommentTarget,
} from "./liveComments";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/core/liveComments.test.ts`
Expected: FAIL with `buildUserLiveComment is not a function` (or `Cannot find name 'buildUserLiveComment'`).

- [ ] **Step 3: Implement `buildUserLiveComment`**

In `src/core/liveComments.ts`, append after the existing `buildLiveComment` function:

```ts
/** Convert one cursor-driven user comment into a live annotation. */
export function buildUserLiveComment(
  input: CommentTargetInput & { side: DiffSide; line: number },
  commentId: string,
  createdAt: string,
  hunkIndex: number,
): LiveComment {
  return {
    id: commentId,
    source: "user",
    author: input.author,
    createdAt,
    filePath: input.filePath,
    hunkIndex,
    side: input.side,
    line: input.line,
    summary: input.summary,
    rationale: input.rationale,
    oldRange: input.side === "old" ? [input.line, input.line] : undefined,
    newRange: input.side === "new" ? [input.line, input.line] : undefined,
    tags: ["user"],
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/liveComments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/liveComments.ts src/core/liveComments.test.ts
git commit -m "feat(comments): add buildUserLiveComment for cursor-authored comments"
```

---

### Task 3: Cursor geometry helpers

**Files:**

- Create: `src/ui/lib/commentCursor.ts`
- Test: `src/ui/lib/commentCursor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/ui/lib/commentCursor.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import {
  cursorRowStableKey,
  firstCursorTargetForHunk,
  moveCursor,
  type CommentCursorPosition,
} from "./commentCursor";

const beforeLines = Array.from({ length: 12 }, (_, index) => `line${index + 1}`);
const afterLines = [...beforeLines];
afterLines[0] = "LINE1";
afterLines[10] = "LINE11";

function createTwoHunkFile() {
  return createTestDiffFile({
    id: "alpha",
    path: "alpha.ts",
    before: lines(...beforeLines),
    after: lines(...afterLines),
    context: 1,
  });
}

function createSingleHunkFile() {
  const before = lines("a", "b", "c");
  const after = lines("a", "B", "c");
  return createTestDiffFile({
    id: "beta",
    path: "beta.ts",
    before,
    after,
    context: 1,
  });
}

describe("firstCursorTargetForHunk", () => {
  test("prefers the first added line", () => {
    const file = createTwoHunkFile();

    const target = firstCursorTargetForHunk(file, 0);
    expect(target).toEqual({ side: "new", line: 1 });
  });
});

describe("cursorRowStableKey", () => {
  test("formats a stable key matching the diff render plan", () => {
    const key = cursorRowStableKey({
      fileId: "alpha",
      hunkIndex: 2,
      side: "new",
      line: 42,
    });

    expect(key).toBe("line:2:new:42");
  });
});

describe("moveCursor", () => {
  test("steps forward through diff rows within a hunk", () => {
    const file = createTwoHunkFile();
    const start: CommentCursorPosition = {
      fileId: "alpha",
      hunkIndex: 0,
      ...firstCursorTargetForHunk(file, 0),
    };

    const next = moveCursor([file], start, 1);
    expect(next).not.toBeNull();
    expect(next?.fileId).toBe("alpha");
  });

  test("crosses hunk boundaries when stepping past the last row of a hunk", () => {
    const file = createTwoHunkFile();
    const lastHunkIndex = file.metadata.hunks.length - 1;
    const lastHunk = file.metadata.hunks[lastHunkIndex]!;
    const start: CommentCursorPosition = {
      fileId: "alpha",
      hunkIndex: lastHunkIndex,
      ...firstCursorTargetForHunk(file, lastHunkIndex),
    };

    let cursor: CommentCursorPosition | null = start;
    for (let step = 0; step < 200 && cursor !== null; step += 1) {
      const next = moveCursor([file], cursor, 1);
      if (!next || next.hunkIndex !== cursor.hunkIndex) {
        break;
      }
      cursor = next;
    }

    // Either we landed in a later hunk, or clamped at the end of the only hunk.
    expect(cursor).not.toBeNull();
    expect(cursor!.hunkIndex).toBeGreaterThanOrEqual(0);
    expect(lastHunk).toBeDefined();
  });

  test("crosses file boundaries when stepping past the last row of the last hunk", () => {
    const fileA = createSingleHunkFile();
    const fileB = createTestDiffFile({
      id: "gamma",
      path: "gamma.ts",
      before: lines("g1", "g2", "g3"),
      after: lines("g1", "G2", "g3"),
      context: 1,
    });
    const startInA: CommentCursorPosition = {
      fileId: "beta",
      hunkIndex: 0,
      ...firstCursorTargetForHunk(fileA, 0),
    };

    let cursor: CommentCursorPosition | null = startInA;
    for (let step = 0; step < 200 && cursor !== null; step += 1) {
      const next = moveCursor([fileA, fileB], cursor, 1);
      if (!next || next.fileId !== cursor.fileId) {
        cursor = next;
        break;
      }
      cursor = next;
    }

    expect(cursor?.fileId).toBe("gamma");
  });

  test("clamps at the first row of the first hunk when stepping backwards from the start", () => {
    const file = createSingleHunkFile();
    const start: CommentCursorPosition = {
      fileId: "beta",
      hunkIndex: 0,
      ...firstCursorTargetForHunk(file, 0),
    };

    const previous = moveCursor([file], start, -1);
    expect(previous).toEqual(start);
  });

  test("returns null when given an empty file list", () => {
    expect(moveCursor([], { fileId: "ghost", hunkIndex: 0, side: "new", line: 1 }, 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/ui/lib/commentCursor.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the cursor helpers**

Create `src/ui/lib/commentCursor.ts`:

```ts
import type { Hunk } from "@pierre/diffs";
import type { DiffFile } from "../../core/types";
import { firstCommentTargetForHunk, hunkLineRange } from "../../core/liveComments";
import type { DiffSide } from "../../hunk-session/types";

export interface CommentCursorPosition {
  fileId: string;
  hunkIndex: number;
  side: DiffSide;
  line: number;
}

/** Return the cursor anchor for one hunk — first addition, then deletion, then context. */
export function firstCursorTargetForHunk(
  file: DiffFile,
  hunkIndex: number,
): { side: DiffSide; line: number } {
  const hunk = file.metadata.hunks[hunkIndex];
  if (!hunk) {
    return { side: "new", line: 1 };
  }

  return firstCommentTargetForHunk(hunk);
}

/** Build the file-scoped stable row key used by reviewRenderPlan for a cursor position. */
export function cursorRowStableKey(cursor: CommentCursorPosition): string {
  return `line:${cursor.hunkIndex}:${cursor.side}:${cursor.line}`;
}

/** Walk through every content line of a hunk on the cursor's anchor side. */
function* walkHunkLines(hunk: Hunk, side: DiffSide): Generator<{ side: DiffSide; line: number }> {
  const range = hunkLineRange(hunk);
  const [start, end] = side === "new" ? range.newRange : range.oldRange;

  for (let line = start; line <= end; line += 1) {
    yield { side, line };
  }
}

/** Build the ordered list of cursor positions for the full review stream on the cursor's side. */
function buildCursorPositions(files: DiffFile[], preferredSide: DiffSide): CommentCursorPosition[] {
  const positions: CommentCursorPosition[] = [];

  for (const file of files) {
    file.metadata.hunks.forEach((hunk, hunkIndex) => {
      for (const step of walkHunkLines(hunk, preferredSide)) {
        positions.push({
          fileId: file.id,
          hunkIndex,
          side: step.side,
          line: step.line,
        });
      }
    });
  }

  return positions;
}

/** Move the cursor forward or backward through the review stream by one row. */
export function moveCursor(
  files: DiffFile[],
  current: CommentCursorPosition,
  delta: number,
): CommentCursorPosition | null {
  const positions = buildCursorPositions(files, current.side);
  if (positions.length === 0) {
    return null;
  }

  const index = positions.findIndex(
    (position) =>
      position.fileId === current.fileId &&
      position.hunkIndex === current.hunkIndex &&
      position.line === current.line,
  );

  if (index < 0) {
    return delta >= 0 ? positions[0]! : positions[positions.length - 1]!;
  }

  const nextIndex = Math.max(0, Math.min(positions.length - 1, index + delta));
  return positions[nextIndex]!;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/ui/lib/commentCursor.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/lib/commentCursor.ts src/ui/lib/commentCursor.test.ts
git commit -m "feat(ui): add commentCursor geometry helpers"
```

---

### Task 4: Cursor state in `useReviewController`

**Files:**

- Modify: `src/ui/hooks/useReviewController.ts`
- Test: `src/ui/hooks/useReviewController.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `src/ui/hooks/useReviewController.test.tsx`, append inside the top-level `describe(...)` block (or add a new one near the end of the file). First add the new import next to the existing controller import:

```ts
import { useReviewController, type ReviewController } from "./useReviewController";
```

Then add the new test block:

```ts
describe("useReviewController cursor state", () => {
  test("turning cursor on seeds it from the currently selected hunk", async () => {
    let controllerRef: ReviewController | null = null;
    const file = createTwoHunkFile();
    const setup = await testRender(
      <ReviewControllerHarness
        initialFiles={[file]}
        onController={(controller) => {
          controllerRef = controller;
        }}
      />,
    );

    try {
      await flush(setup);
      const controller = expectValue(controllerRef);
      expect(controller.commentCursor.mode).toBe("off");

      await act(async () => {
        controller.setCommentCursorMode("navigating");
      });
      await flush(setup);

      const next = expectValue(controllerRef);
      expect(next.commentCursor.mode).toBe("navigating");
      expect(next.commentCursor.fileId).toBe(file.id);
      expect(next.commentCursor.hunkIndex).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("addUserLiveComment stores a user comment that surfaces in liveCommentSummaries", async () => {
    let controllerRef: ReviewController | null = null;
    const file = createTwoHunkFile();
    const setup = await testRender(
      <ReviewControllerHarness
        initialFiles={[file]}
        onController={(controller) => {
          controllerRef = controller;
        }}
      />,
    );

    try {
      await flush(setup);
      const controller = expectValue(controllerRef);

      await act(async () => {
        controller.addUserLiveComment(
          { fileId: file.id, hunkIndex: 0, side: "new", line: 1 },
          "Needs a follow-up",
        );
      });
      await flush(setup);

      const after = expectValue(controllerRef);
      expect(after.liveCommentCount).toBe(1);
      expect(after.liveCommentSummaries[0]?.summary).toBe("Needs a follow-up");
      expect(after.liveCommentSummaries[0]?.filePath).toBe(file.path);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/ui/hooks/useReviewController.test.tsx`
Expected: FAIL — `setCommentCursorMode is not a function` (or similar missing property).

- [ ] **Step 3: Extend the controller interface and implementation**

In `src/ui/hooks/useReviewController.ts`, add imports next to the existing ones:

```ts
import {
  cursorRowStableKey,
  firstCursorTargetForHunk,
  moveCursor,
  type CommentCursorPosition,
} from "../lib/commentCursor";
import { buildUserLiveComment } from "../../core/liveComments";
import type { DiffSide } from "../../hunk-session/types";
```

Add new types above `ReviewController`:

```ts
export type CommentCursorMode = "off" | "navigating" | "composing";

export interface CommentCursorState extends CommentCursorPosition {
  mode: CommentCursorMode;
}

export interface AddUserLiveCommentTarget {
  fileId: string;
  hunkIndex: number;
  side: DiffSide;
  line: number;
  author?: string;
}
```

Extend the `ReviewController` interface to add (place these next to the existing actions, in alphabetical-ish order matching the file's style):

```ts
  commentCursor: CommentCursorState;
  commentCursorRowStableKey: string | null;
  addUserLiveComment: (target: AddUserLiveCommentTarget, summary: string) => AppliedCommentResult;
  setCommentCursorMode: (mode: CommentCursorMode) => void;
  moveCommentCursor: (delta: number) => void;
  jumpCommentCursorToHunk: (delta: number) => void;
```

Inside `useReviewController`, near the other `useState` calls, add:

```ts
const [commentCursor, setCommentCursor] = useState<CommentCursorState>(() => ({
  mode: "off",
  fileId: files[0]?.id ?? "",
  hunkIndex: 0,
  side: "new",
  line: files[0]?.metadata.hunks[0] ? firstCursorTargetForHunk(files[0], 0).line : 1,
}));
const userCommentCounterRef = useRef(0);
```

Add `useRef` to the React import at the top of the file if it is not already present:

```ts
import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
```

Define the cursor actions (place these after `clearLiveComments` and before the controller return statement):

```ts
/** Enter, switch, or leave the cursor mode. Seeds position from the selected hunk on enter. */
const setCommentCursorMode = useCallback(
  (mode: CommentCursorMode) => {
    setCommentCursor((current) => {
      if (mode === "off") {
        return { ...current, mode };
      }

      if (current.mode !== "off") {
        return { ...current, mode };
      }

      const file = visibleFiles.find((entry) => entry.id === selectedFileId) ?? visibleFiles[0];
      if (!file || file.metadata.hunks.length === 0) {
        return { ...current, mode };
      }

      const hunkIndex = Math.max(0, Math.min(selectedHunkIndex, file.metadata.hunks.length - 1));
      const anchor = firstCursorTargetForHunk(file, hunkIndex);
      return {
        mode,
        fileId: file.id,
        hunkIndex,
        side: anchor.side,
        line: anchor.line,
      };
    });
  },
  [selectedFileId, selectedHunkIndex, visibleFiles],
);

/** Walk the cursor row-by-row through the review stream. */
const moveCommentCursor = useCallback(
  (delta: number) => {
    setCommentCursor((current) => {
      if (current.mode === "off") {
        return current;
      }

      const next = moveCursor(visibleFiles, current, delta);
      if (!next) {
        return current;
      }

      return { ...current, ...next };
    });
  },
  [visibleFiles],
);

/** Jump the cursor to the first content row of the previous or next hunk. */
const jumpCommentCursorToHunk = useCallback(
  (delta: number) => {
    setCommentCursor((current) => {
      if (current.mode === "off") {
        return current;
      }

      const fileIndex = visibleFiles.findIndex((file) => file.id === current.fileId);
      if (fileIndex < 0) {
        return current;
      }

      let nextFileIndex = fileIndex;
      let nextHunkIndex = current.hunkIndex + delta;

      while (true) {
        const file = visibleFiles[nextFileIndex];
        if (!file) {
          return current;
        }

        if (nextHunkIndex >= 0 && nextHunkIndex < file.metadata.hunks.length) {
          const anchor = firstCursorTargetForHunk(file, nextHunkIndex);
          return {
            ...current,
            fileId: file.id,
            hunkIndex: nextHunkIndex,
            side: anchor.side,
            line: anchor.line,
          };
        }

        if (delta > 0) {
          nextFileIndex += 1;
          nextHunkIndex = 0;
        } else {
          nextFileIndex -= 1;
          const previous = visibleFiles[nextFileIndex];
          if (!previous) {
            return current;
          }
          nextHunkIndex = previous.metadata.hunks.length - 1;
        }
      }
    });
  },
  [visibleFiles],
);

/** Persist one user-authored comment using the same store as MCP comments. */
const addUserLiveComment = useCallback(
  (target: AddUserLiveCommentTarget, summary: string): AppliedCommentResult => {
    const file = allFiles.find((entry) => entry.id === target.fileId);
    if (!file) {
      throw new Error(`No diff file matches ${target.fileId}.`);
    }

    const trimmed = summary.trim();
    if (!trimmed) {
      throw new Error("User comments must have a non-empty summary.");
    }

    userCommentCounterRef.current += 1;
    const commentId = `user:${Date.now()}-${userCommentCounterRef.current}`;
    const liveComment = buildUserLiveComment(
      {
        filePath: file.path,
        side: target.side,
        line: target.line,
        summary: trimmed,
        author: target.author,
      },
      commentId,
      new Date().toISOString(),
      target.hunkIndex,
    );

    setLiveCommentsByFileId((current) => ({
      ...current,
      [file.id]: [...(current[file.id] ?? []), liveComment],
    }));

    return {
      commentId,
      fileId: file.id,
      filePath: file.path,
      hunkIndex: target.hunkIndex,
      side: target.side,
      line: target.line,
    };
  },
  [allFiles],
);

const commentCursorRowStableKey =
  commentCursor.mode === "off" ? null : cursorRowStableKey(commentCursor);
```

Add a reconcile effect so the cursor never points at a file that disappeared from the visible stream. Place it next to the existing `reconcileSelectedFile` effect block:

```ts
useEffect(() => {
  setCommentCursor((current) => {
    if (current.mode === "off") {
      return current;
    }

    const file = visibleFiles.find((entry) => entry.id === current.fileId);
    if (file && current.hunkIndex < file.metadata.hunks.length) {
      return current;
    }

    const fallbackFile = visibleFiles[0];
    if (!fallbackFile || fallbackFile.metadata.hunks.length === 0) {
      return { ...current, mode: "off" };
    }

    const anchor = firstCursorTargetForHunk(fallbackFile, 0);
    return {
      mode: current.mode,
      fileId: fallbackFile.id,
      hunkIndex: 0,
      side: anchor.side,
      line: anchor.line,
    };
  });
}, [visibleFiles]);
```

Add the new fields to the `return` block at the bottom of `useReviewController`:

```ts
    commentCursor,
    commentCursorRowStableKey,
    addUserLiveComment,
    setCommentCursorMode,
    moveCommentCursor,
    jumpCommentCursorToHunk,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/ui/hooks/useReviewController.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/hooks/useReviewController.ts src/ui/hooks/useReviewController.test.tsx
git commit -m "feat(review): own comment cursor state and addUserLiveComment in the review controller"
```

---

### Task 5: `CommentComposer` component

**Files:**

- Create: `src/ui/components/panes/CommentComposer.tsx`

- [ ] **Step 1: Write the component**

Create `src/ui/components/panes/CommentComposer.tsx`:

```ts
import { useState } from "react";
import type { KeyEvent } from "@opentui/core";
import { isEscapeKey } from "../../lib/keyboard";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";

/** Render the inline composer card the user types a single review comment into. */
export function CommentComposer({
  filePath,
  hunkIndex,
  line,
  side,
  theme,
  width,
  onCancel,
  onSubmit,
}: {
  filePath: string;
  hunkIndex: number;
  line: number;
  side: "old" | "new";
  theme: AppTheme;
  width: number;
  onCancel: () => void;
  onSubmit: (summary: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const sideLabel = side === "new" ? "+" : "-";
  const titleText = `Comment · ${filePath}:${sideLabel}${line}@${hunkIndex + 1}   Enter save · Esc cancel`;
  const boxWidth = Math.max(28, Math.min(width - 4, Math.max(28, width - 4)));
  const innerWidth = Math.max(1, boxWidth - 2);
  const topBorder = `┌${"─".repeat(Math.max(0, boxWidth - 2))}┐`;
  const bottomBorder = `└${"─".repeat(Math.max(0, boxWidth - 2))}┘`;
  const boxLeft = Math.min(4, Math.max(0, width - boxWidth));

  const handleKeyDown = (key: KeyEvent) => {
    if (!isEscapeKey(key)) {
      return;
    }

    key.preventDefault();
    key.stopPropagation();
    onCancel();
  };

  const handleSubmit = (value: string) => {
    if (value.trim().length === 0) {
      onCancel();
      return;
    }
    onSubmit(value);
  };

  return (
    <box style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: boxWidth, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>
            {topBorder}
          </text>
        </box>
      </box>

      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>
            │
          </text>
        </box>
        <box style={{ width: innerWidth, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteTitleText} bg={theme.noteTitleBackground}>
            {padText(fitText(titleText, innerWidth), innerWidth)}
          </text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>
            │
          </text>
        </box>
      </box>

      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>
            │
          </text>
        </box>
        <input
          width={innerWidth}
          value={draft}
          placeholder="describe what you want the agent to look at"
          focused={true}
          onInput={setDraft}
          onSubmit={handleSubmit}
          onKeyDown={handleKeyDown}
        />
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>
            │
          </text>
        </box>
      </box>

      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: boxWidth, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>
            {bottomBorder}
          </text>
        </box>
      </box>
    </box>
  );
}

/** Constant terminal-row height the composer occupies inside the diff stream. */
export const COMMENT_COMPOSER_HEIGHT = 4;
```

- [ ] **Step 2: Run typecheck to verify the component is valid**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/panes/CommentComposer.tsx
git commit -m "feat(ui): add CommentComposer card for inline cursor-driven comments"
```

---

### Task 6: `comment-composer` planned row kind

**Files:**

- Modify: `src/ui/diff/reviewRenderPlan.ts`

- [ ] **Step 1: Extend the planned-row type and insertion logic**

In `src/ui/diff/reviewRenderPlan.ts`, add a new variant to `PlannedReviewRow` at the end of the union (after the existing `note-guide-cap` variant):

```ts
  | {
      kind: "comment-composer";
      key: string;
      stableKey: string;
      fileId: string;
      hunkIndex: number;
      side: "old" | "new";
      line: number;
    };
```

Then extend the function signature and insertion logic. Replace the entire `buildReviewRenderPlan` function with:

```ts
/**
 * Build the explicit presentational row plan for one file diff body.
 * The plan always preserves diff-row order and may insert inline notes, trailing guide caps
 * for every visible note anchored in this file, and one composer row when the user is
 * currently composing a comment in this file.
 */
export function buildReviewRenderPlan({
  fileId,
  rows,
  showHunkHeaders,
  visibleAgentNotes = EMPTY_VISIBLE_AGENT_NOTES,
  selectedHunkIndex: _selectedHunkIndex,
  composer = null,
}: {
  fileId: string;
  rows: DiffRow[];
  showHunkHeaders: boolean;
  visibleAgentNotes?: VisibleAgentNote[];
  selectedHunkIndex?: number;
  composer?: {
    fileId: string;
    hunkIndex: number;
    side: "old" | "new";
    line: number;
  } | null;
}) {
  const placementsByAnchor = buildInlineVisibleNotePlacements(rows, visibleAgentNotes);
  const noteGuideSideByRowKey = buildNoteGuideSideByRowKey(placementsByAnchor);
  const guideCapsByRowKey = buildGuideCapsByRowKey(placementsByAnchor);
  const plannedRows: PlannedReviewRow[] = [];
  const anchoredHunks = new Set<number>();
  const composerAnchorStableKey =
    composer && composer.fileId === fileId
      ? `line:${composer.hunkIndex}:${composer.side}:${composer.line}`
      : null;
  let composerInserted = false;

  for (const row of rows) {
    const shouldAnchorHunk =
      rowCanAnchorHunk(row, showHunkHeaders) && !anchoredHunks.has(row.hunkIndex);
    const anchorId = shouldAnchorHunk ? diffHunkId(fileId, row.hunkIndex) : undefined;
    const diffStableKeys = diffRowStableKeys(row);
    const diffStableKey = diffStableKeys[0] ?? `row:${row.key}`;
    const diffStableAliasKeys = diffStableKeys.slice(1);

    if (shouldAnchorHunk) {
      anchoredHunks.add(row.hunkIndex);
    }

    const anchoredNotes = placementsByAnchor.get(row.key) ?? [];
    anchoredNotes.forEach((placement) => {
      plannedRows.push({
        kind: "inline-note",
        key: `inline-note:${placement.note.id}:${row.key}:${placement.noteIndex}`,
        stableKey: `inline-note:${placement.note.id}`,
        fileId,
        hunkIndex: placement.hunkIndex,
        annotationId: placement.note.id,
        annotation: placement.note.annotation,
        anchorSide: placement.anchorSide,
        noteCount: placement.noteCount,
        noteIndex: placement.noteIndex,
      });
    });

    plannedRows.push({
      kind: "diff-row",
      key: `diff-row:${row.key}`,
      stableKey: diffStableKey,
      stableAliasKeys: diffStableAliasKeys,
      fileId: row.fileId,
      hunkIndex: row.hunkIndex,
      row,
      anchorId,
      noteGuideSide: noteGuideSideByRowKey.get(row.key),
    });

    if (
      composer &&
      composerAnchorStableKey &&
      !composerInserted &&
      diffStableKeys.includes(composerAnchorStableKey)
    ) {
      plannedRows.push({
        kind: "comment-composer",
        key: `comment-composer:${composer.hunkIndex}:${composer.side}:${composer.line}`,
        stableKey: `comment-composer:${composer.hunkIndex}:${composer.side}:${composer.line}`,
        fileId,
        hunkIndex: composer.hunkIndex,
        side: composer.side,
        line: composer.line,
      });
      composerInserted = true;
    }

    const guideCaps = guideCapsByRowKey.get(row.key);
    if (guideCaps) {
      Array.from(guideCaps).forEach((side) => {
        plannedRows.push({
          kind: "note-guide-cap",
          key: `note-guide-cap:${row.key}:${side}`,
          stableKey: `note-guide-cap:${side}:${diffRowStableKeyForSide(row, side) ?? diffStableKey}`,
          fileId,
          hunkIndex: row.hunkIndex,
          side,
        });
      });
    }
  }

  return plannedRows;
}
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Run the existing review-render tests to verify nothing broke**

Run: `bun test src/ui/diff/reviewRenderPlan.test.ts`
Expected: PASS — existing tests do not pass `composer`, so behaviour is unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/ui/diff/reviewRenderPlan.ts
git commit -m "feat(diff): add comment-composer planned row kind for inline comment composer"
```

---

### Task 7: Composer row geometry

**Files:**

- Modify: `src/ui/lib/diffSectionGeometry.ts`

- [ ] **Step 1: Plumb the composer through geometry and measure its height**

In `src/ui/lib/diffSectionGeometry.ts`, add the composer import at the top:

```ts
import { COMMENT_COMPOSER_HEIGHT } from "../components/panes/CommentComposer";
```

Update `buildBasePlannedRows` to accept and forward the composer parameter. Replace the existing function with:

```ts
function buildBasePlannedRows(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  theme: AppTheme,
  visibleAgentNotes: VisibleAgentNote[],
  composer: {
    fileId: string;
    hunkIndex: number;
    side: "old" | "new";
    line: number;
  } | null,
) {
  const rows =
    layout === "split" ? buildSplitRows(file, null, theme) : buildStackRows(file, null, theme);

  return buildReviewRenderPlan({
    fileId: file.id,
    rows,
    selectedHunkIndex: -1,
    showHunkHeaders,
    visibleAgentNotes,
    composer,
  });
}
```

Update `plannedRowHeight` to handle the composer kind. Replace it with:

```ts
function plannedRowHeight(
  row: PlannedReviewRow,
  showHunkHeaders: boolean,
  layout: Exclude<LayoutMode, "auto">,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  wrapLines: boolean,
  theme: AppTheme,
) {
  if (row.kind === "inline-note") {
    return measureAgentInlineNoteHeight({
      annotation: row.annotation,
      anchorSide: row.anchorSide,
      layout,
      width,
    });
  }

  if (row.kind === "note-guide-cap") {
    return 1;
  }

  if (row.kind === "comment-composer") {
    return COMMENT_COMPOSER_HEIGHT;
  }

  return measureRenderedRowHeight(
    row.row,
    width,
    lineNumberDigits,
    showLineNumbers,
    showHunkHeaders,
    wrapLines,
    theme,
  );
}
```

Update `rowContributesToHunkBounds` so the composer row keeps the owning hunk's bounds growing while it is mounted:

```ts
function rowContributesToHunkBounds(row: PlannedReviewRow) {
  return !(row.kind === "diff-row" && row.row.type === "collapsed");
}
```

(No change required — composer already counts because the early-return only excludes collapsed diff rows.)

Update `measureDiffSectionGeometry` to accept and forward the composer argument. Replace its signature and body with:

```ts
export function measureDiffSectionGeometry(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  theme: AppTheme,
  visibleAgentNotes: VisibleAgentNote[] = [],
  width = 0,
  showLineNumbers = true,
  wrapLines = false,
  composer: {
    fileId: string;
    hunkIndex: number;
    side: "old" | "new";
    line: number;
  } | null = null,
): DiffSectionGeometry {
  if (file.metadata.hunks.length === 0) {
    return {
      bodyHeight: 1,
      hunkAnchorRows: new Map(),
      hunkBounds: new Map(),
      rowBounds: [],
      rowBoundsByKey: new Map(),
      rowBoundsByStableKey: new Map(),
    };
  }

  const composerKey =
    composer && composer.fileId === file.id
      ? `${composer.hunkIndex}:${composer.side}:${composer.line}`
      : "none";
  const cacheKey = `${file.id}:${layout}:${showHunkHeaders ? 1 : 0}:${theme.id}:${width}:${showLineNumbers ? 1 : 0}:${wrapLines ? 1 : 0}:${composerKey}`;
  if (visibleAgentNotes.length > 0) {
    const cachedByNotes = NOTE_AWARE_SECTION_GEOMETRY_CACHE.get(visibleAgentNotes);
    const cached = cachedByNotes?.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const plannedRows = buildBasePlannedRows(
    file,
    layout,
    showHunkHeaders,
    theme,
    visibleAgentNotes,
    composer,
  );
  const hunkAnchorRows = new Map<number, number>();
  const hunkBounds = new Map<number, PlannedHunkBounds>();
  const rowBounds: DiffSectionRowBounds[] = [];
  const rowBoundsByKey = new Map<string, DiffSectionRowBounds>();
  const rowBoundsByStableKey = new Map<string, DiffSectionRowBounds>();
  const lineNumberDigits = String(findMaxLineNumber(file)).length;
  let bodyHeight = 0;

  for (const row of plannedRows) {
    if (row.kind === "diff-row" && row.anchorId && !hunkAnchorRows.has(row.hunkIndex)) {
      hunkAnchorRows.set(row.hunkIndex, bodyHeight);
    }

    const height = plannedRowHeight(
      row,
      showHunkHeaders,
      layout,
      width,
      lineNumberDigits,
      showLineNumbers,
      wrapLines,
      theme,
    );
    const stableKeys = [
      row.stableKey,
      ...(row.kind === "diff-row" ? (row.stableAliasKeys ?? []) : []),
    ];
    const rowBoundsEntry = {
      key: row.key,
      stableKey: row.stableKey,
      stableKeys,
      top: bodyHeight,
      height,
    };
    rowBounds.push(rowBoundsEntry);
    rowBoundsByKey.set(row.key, rowBoundsEntry);
    for (const stableKey of stableKeys) {
      if (!rowBoundsByStableKey.has(stableKey)) {
        rowBoundsByStableKey.set(stableKey, rowBoundsEntry);
      }
    }

    if (height > 0 && rowContributesToHunkBounds(row)) {
      const rowId = reviewRowId(row.key);
      const existingBounds = hunkBounds.get(row.hunkIndex);

      if (existingBounds) {
        existingBounds.endRowId = rowId;
        existingBounds.height += height;
      } else {
        hunkBounds.set(row.hunkIndex, {
          top: bodyHeight,
          height,
          startRowId: rowId,
          endRowId: rowId,
        });
      }
    }

    bodyHeight += height;
  }

  const geometry: DiffSectionGeometry = {
    bodyHeight,
    hunkAnchorRows,
    hunkBounds,
    rowBounds,
    rowBoundsByKey,
    rowBoundsByStableKey,
  };

  if (visibleAgentNotes.length > 0) {
    const cachedByNotes = NOTE_AWARE_SECTION_GEOMETRY_CACHE.get(visibleAgentNotes) ?? new Map();
    cachedByNotes.set(cacheKey, geometry);
    NOTE_AWARE_SECTION_GEOMETRY_CACHE.set(visibleAgentNotes, cachedByNotes);
  }

  return geometry;
}
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Run the existing geometry tests**

Run: `bun test src/ui/lib/diffSectionGeometry.test.ts`
Expected: PASS — existing callers do not pass the new `composer` argument, so behaviour is unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/ui/lib/diffSectionGeometry.ts
git commit -m "feat(diff): measure the comment composer row in diff section geometry"
```

---

### Task 8: Render the cursor highlight and composer in the diff view

**Files:**

- Modify: `src/ui/diff/renderRows.tsx`
- Modify: `src/ui/diff/PierreDiffView.tsx`

- [ ] **Step 1: Plumb `isCursor` through `DiffRowView`**

In `src/ui/diff/renderRows.tsx`, update the `renderHeaderRow` and `renderRow` signatures to accept an `isCursor` boolean, then make the row prefix render the cursor marker when set.

Locate `renderRow` and update its parameter list to include `isCursor: boolean = false` immediately after the existing `selected: boolean` parameter. Replace `function renderRow(` through the end of the function with this (only the marker-related lines change — the rest is preserved):

Find these lines inside the split-line branch:

```ts
const leftPrefix = {
  text: guideOnOldSide ? "│" : marker(),
  fg: guideOnOldSide ? theme.noteBorder : splitLeftRailColor(row.left.kind, theme, selected),
  bg: theme.panel,
};
```

Replace with:

```ts
const leftPrefix = {
  text: guideOnOldSide ? "│" : isCursor ? "▶" : marker(),
  fg: guideOnOldSide
    ? theme.noteBorder
    : isCursor
      ? theme.noteTitleText
      : splitLeftRailColor(row.left.kind, theme, selected),
  bg: isCursor ? theme.noteTitleBackground : theme.panel,
};
```

Find these lines inside the stack-line branch:

```ts
const prefix = {
  text: guideOnOldSide ? "│" : marker(),
  fg: guideOnOldSide ? theme.noteBorder : stackRailColor(row.cell.kind, theme, selected),
  bg: theme.panel,
};
```

Replace with:

```ts
const prefix = {
  text: guideOnOldSide ? "│" : isCursor ? "▶" : marker(),
  fg: guideOnOldSide
    ? theme.noteBorder
    : isCursor
      ? theme.noteTitleText
      : stackRailColor(row.cell.kind, theme, selected),
  bg: isCursor ? theme.noteTitleBackground : theme.panel,
};
```

Add `isCursor` to the `renderRow` parameter list. Find:

```ts
function renderRow(
  row: DiffRow,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  showHunkHeaders: boolean,
  wrapLines: boolean,
  codeHorizontalOffset: number,
  theme: AppTheme,
  selected: boolean,
  annotated: boolean,
  anchorId?: string,
  noteGuideSide?: "old" | "new",
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void,
) {
```

Replace with:

```ts
function renderRow(
  row: DiffRow,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  showHunkHeaders: boolean,
  wrapLines: boolean,
  codeHorizontalOffset: number,
  theme: AppTheme,
  selected: boolean,
  annotated: boolean,
  anchorId?: string,
  noteGuideSide?: "old" | "new",
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void,
  isCursor: boolean = false,
) {
```

Update `DiffRowViewProps` to accept `isCursor`:

```ts
interface DiffRowViewProps {
  row: DiffRow;
  width: number;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  wrapLines: boolean;
  codeHorizontalOffset: number;
  theme: AppTheme;
  selected: boolean;
  annotated: boolean;
  anchorId?: string;
  noteGuideSide?: "old" | "new";
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void;
  isCursor?: boolean;
}
```

Update the memoized component body and prop equality. Replace the `DiffRowView` export with:

```ts
export const DiffRowView = memo(
  function DiffRowViewComponent({
    row,
    width,
    lineNumberDigits,
    showLineNumbers,
    showHunkHeaders,
    wrapLines,
    codeHorizontalOffset,
    theme,
    selected,
    annotated,
    anchorId,
    noteGuideSide,
    onOpenAgentNotesAtHunk,
    isCursor = false,
  }: DiffRowViewProps) {
    return renderRow(
      row,
      width,
      lineNumberDigits,
      showLineNumbers,
      showHunkHeaders,
      wrapLines,
      codeHorizontalOffset,
      theme,
      selected,
      annotated,
      anchorId,
      noteGuideSide,
      onOpenAgentNotesAtHunk,
      isCursor,
    );
  },
  (previous, next) => {
    return (
      previous.row === next.row &&
      previous.width === next.width &&
      previous.lineNumberDigits === next.lineNumberDigits &&
      previous.showLineNumbers === next.showLineNumbers &&
      previous.showHunkHeaders === next.showHunkHeaders &&
      previous.wrapLines === next.wrapLines &&
      previous.codeHorizontalOffset === next.codeHorizontalOffset &&
      previous.theme === next.theme &&
      previous.selected === next.selected &&
      previous.annotated === next.annotated &&
      previous.anchorId === next.anchorId &&
      previous.noteGuideSide === next.noteGuideSide &&
      previous.isCursor === next.isCursor
    );
  },
);
```

- [ ] **Step 2: Plumb the cursor row key and composer through `PierreDiffView`**

In `src/ui/diff/PierreDiffView.tsx`, add the composer import next to the existing imports:

```ts
import { CommentComposer } from "../components/panes/CommentComposer";
```

Extend the prop signature. Replace the `PierreDiffView` parameter list and destructure with:

```ts
export function PierreDiffView({
  annotatedHunkIndices = EMPTY_ANNOTATED_HUNK_INDICES,
  codeHorizontalOffset = 0,
  commentCursorRowStableKey,
  composer,
  file,
  layout,
  onCommentComposerCancel,
  onCommentComposerSubmit,
  onOpenAgentNotesAtHunk,
  showLineNumbers = true,
  showHunkHeaders = true,
  wrapLines = false,
  theme,
  visibleAgentNotes = EMPTY_VISIBLE_AGENT_NOTES,
  width,
  selectedHunkIndex,
  sectionGeometry,
  shouldLoadHighlight = true,
  scrollable = true,
  visibleBodyBounds,
}: {
  annotatedHunkIndices?: Set<number>;
  codeHorizontalOffset?: number;
  commentCursorRowStableKey?: string | null;
  composer?: {
    fileId: string;
    hunkIndex: number;
    side: "old" | "new";
    line: number;
  } | null;
  file: DiffFile | undefined;
  layout: Exclude<LayoutMode, "auto">;
  onCommentComposerCancel?: () => void;
  onCommentComposerSubmit?: (summary: string) => void;
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void;
  showLineNumbers?: boolean;
  showHunkHeaders?: boolean;
  wrapLines?: boolean;
  theme: AppTheme;
  visibleAgentNotes?: VisibleAgentNote[];
  width: number;
  selectedHunkIndex: number;
  sectionGeometry?: DiffSectionGeometry;
  shouldLoadHighlight?: boolean;
  scrollable?: boolean;
  visibleBodyBounds?: VisibleBodyBounds;
}) {
```

Update the `plannedRows` `useMemo` to pass the composer through to `buildReviewRenderPlan`:

```ts
const plannedRows = useMemo(
  () =>
    file
      ? buildReviewRenderPlan({
          fileId: file.id,
          rows,
          showHunkHeaders,
          visibleAgentNotes,
          composer: composer ?? null,
        })
      : [],
  [composer, file, rows, showHunkHeaders, visibleAgentNotes],
);
```

Inside the row-mapping branch, add a render case for the `comment-composer` row before the existing diff-row return. Replace:

```ts
        if (plannedRow.kind === "note-guide-cap") {
          return (
            <box key={plannedRow.key} id={rowId} style={{ width: "100%", flexDirection: "column" }}>
              <AgentInlineNoteGuideCap side={plannedRow.side} theme={theme} width={width} />
            </box>
          );
        }

        return (
          <box key={plannedRow.key} id={rowId} style={{ width: "100%", flexDirection: "column" }}>
            <DiffRowView
              row={plannedRow.row}
              width={width}
              lineNumberDigits={lineNumberDigits}
              showLineNumbers={showLineNumbers}
              showHunkHeaders={showHunkHeaders}
              wrapLines={wrapLines}
              codeHorizontalOffset={codeHorizontalOffset}
              theme={theme}
              selected={plannedRow.row.hunkIndex === selectedHunkIndex}
              annotated={
                plannedRow.row.type === "hunk-header" &&
                annotatedHunkIndices.has(plannedRow.row.hunkIndex)
              }
              anchorId={plannedRow.anchorId}
              noteGuideSide={plannedRow.noteGuideSide}
              onOpenAgentNotesAtHunk={onOpenAgentNotesAtHunk}
            />
          </box>
        );
```

With:

```ts
        if (plannedRow.kind === "note-guide-cap") {
          return (
            <box key={plannedRow.key} id={rowId} style={{ width: "100%", flexDirection: "column" }}>
              <AgentInlineNoteGuideCap side={plannedRow.side} theme={theme} width={width} />
            </box>
          );
        }

        if (plannedRow.kind === "comment-composer") {
          return (
            <box key={plannedRow.key} id={rowId} style={{ width: "100%", flexDirection: "column" }}>
              <CommentComposer
                filePath={file.path}
                hunkIndex={plannedRow.hunkIndex}
                line={plannedRow.line}
                side={plannedRow.side}
                theme={theme}
                width={width}
                onCancel={() => onCommentComposerCancel?.()}
                onSubmit={(summary) => onCommentComposerSubmit?.(summary)}
              />
            </box>
          );
        }

        const isCursorRow = Boolean(
          commentCursorRowStableKey &&
            (plannedRow.stableKey === commentCursorRowStableKey ||
              plannedRow.stableAliasKeys?.includes(commentCursorRowStableKey)),
        );

        return (
          <box key={plannedRow.key} id={rowId} style={{ width: "100%", flexDirection: "column" }}>
            <DiffRowView
              row={plannedRow.row}
              width={width}
              lineNumberDigits={lineNumberDigits}
              showLineNumbers={showLineNumbers}
              showHunkHeaders={showHunkHeaders}
              wrapLines={wrapLines}
              codeHorizontalOffset={codeHorizontalOffset}
              theme={theme}
              selected={plannedRow.row.hunkIndex === selectedHunkIndex}
              annotated={
                plannedRow.row.type === "hunk-header" &&
                annotatedHunkIndices.has(plannedRow.row.hunkIndex)
              }
              anchorId={plannedRow.anchorId}
              noteGuideSide={plannedRow.noteGuideSide}
              onOpenAgentNotesAtHunk={onOpenAgentNotesAtHunk}
              isCursor={isCursorRow}
            />
          </box>
        );
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the test suite**

Run: `bun test`
Expected: PASS — these changes are gated on new props nothing else passes yet.

- [ ] **Step 5: Commit**

```bash
git add src/ui/diff/renderRows.tsx src/ui/diff/PierreDiffView.tsx
git commit -m "feat(diff): render the cursor highlight and inline composer in PierreDiffView"
```

---

### Task 9: Plumb the cursor through `DiffPane` and `DiffSection`

**Files:**

- Modify: `src/ui/components/panes/DiffPane.tsx`
- Modify: `src/ui/components/panes/DiffSection.tsx`

- [ ] **Step 1: Accept cursor + composer props in `DiffSection`**

In `src/ui/components/panes/DiffSection.tsx`, update the interface and forward the new props. Replace the `DiffSectionProps` interface and the `DiffSectionComponent` parameter destructure with:

```ts
interface DiffSectionProps {
  codeHorizontalOffset: number;
  commentCursorRowStableKey?: string | null;
  composer?: {
    fileId: string;
    hunkIndex: number;
    side: "old" | "new";
    line: number;
  } | null;
  file: DiffFile;
  headerLabelWidth: number;
  headerStatsWidth: number;
  layout: Exclude<LayoutMode, "auto">;
  selectedHunkIndex: number;
  shouldLoadHighlight: boolean;
  sectionGeometry?: DiffSectionGeometry;
  separatorWidth: number;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  wrapLines: boolean;
  showHeader: boolean;
  showSeparator: boolean;
  theme: AppTheme;
  visibleAgentNotes: VisibleAgentNote[];
  visibleBodyBounds?: VisibleBodyBounds;
  viewWidth: number;
  onCommentComposerCancel?: () => void;
  onCommentComposerSubmit?: (summary: string) => void;
  onOpenAgentNotesAtHunk: (hunkIndex: number) => void;
  onSelect: () => void;
}

function DiffSectionComponent({
  codeHorizontalOffset,
  commentCursorRowStableKey,
  composer,
  file,
  headerLabelWidth,
  headerStatsWidth,
  layout,
  selectedHunkIndex,
  shouldLoadHighlight,
  sectionGeometry,
  separatorWidth,
  showLineNumbers,
  showHunkHeaders,
  wrapLines,
  showHeader,
  showSeparator,
  theme,
  visibleAgentNotes,
  visibleBodyBounds,
  viewWidth,
  onCommentComposerCancel,
  onCommentComposerSubmit,
  onOpenAgentNotesAtHunk,
  onSelect,
}: DiffSectionProps) {
```

Forward the new props to `PierreDiffView`. Replace the `<PierreDiffView ... />` element with:

```ts
      <PierreDiffView
        commentCursorRowStableKey={commentCursorRowStableKey ?? null}
        composer={composer ?? null}
        file={file}
        layout={layout}
        showLineNumbers={showLineNumbers}
        showHunkHeaders={showHunkHeaders}
        wrapLines={wrapLines}
        codeHorizontalOffset={codeHorizontalOffset}
        theme={theme}
        width={viewWidth}
        annotatedHunkIndices={annotatedHunkIndices}
        visibleAgentNotes={visibleAgentNotes}
        onCommentComposerCancel={onCommentComposerCancel}
        onCommentComposerSubmit={onCommentComposerSubmit}
        onOpenAgentNotesAtHunk={onOpenAgentNotesAtHunk}
        selectedHunkIndex={selectedHunkIndex}
        sectionGeometry={sectionGeometry}
        shouldLoadHighlight={shouldLoadHighlight}
        scrollable={false}
        visibleBodyBounds={visibleBodyBounds}
      />
```

Extend the memo comparator. Replace the existing comparator's return expression with:

```ts
return (
  previous.codeHorizontalOffset === next.codeHorizontalOffset &&
  previous.commentCursorRowStableKey === next.commentCursorRowStableKey &&
  previous.composer === next.composer &&
  previous.file === next.file &&
  previous.headerLabelWidth === next.headerLabelWidth &&
  previous.headerStatsWidth === next.headerStatsWidth &&
  previous.layout === next.layout &&
  previous.selectedHunkIndex === next.selectedHunkIndex &&
  previous.shouldLoadHighlight === next.shouldLoadHighlight &&
  previous.sectionGeometry === next.sectionGeometry &&
  previous.separatorWidth === next.separatorWidth &&
  previous.showLineNumbers === next.showLineNumbers &&
  previous.showHunkHeaders === next.showHunkHeaders &&
  previous.wrapLines === next.wrapLines &&
  previous.showHeader === next.showHeader &&
  previous.showSeparator === next.showSeparator &&
  previous.theme === next.theme &&
  previous.visibleAgentNotes === next.visibleAgentNotes &&
  previous.visibleBodyBounds === next.visibleBodyBounds &&
  previous.viewWidth === next.viewWidth
);
```

- [ ] **Step 2: Accept cursor + composer props in `DiffPane`**

In `src/ui/components/panes/DiffPane.tsx`, add the new props to the function signature. Find the existing destructure for `DiffPane` and add:

```ts
  commentCursorRowStableKey,
  composer,
  onCommentComposerCancel,
  onCommentComposerSubmit,
```

after `codeHorizontalOffset`. Add them to the prop type as well:

```ts
  commentCursorRowStableKey?: string | null;
  composer?: {
    fileId: string;
    hunkIndex: number;
    side: "old" | "new";
    line: number;
  } | null;
  onCommentComposerCancel?: () => void;
  onCommentComposerSubmit?: (summary: string) => void;
```

When `DiffPane` measures `sectionGeometry` for the selected file, pass the composer through so the composer row contributes to the file's body height. Locate the `measureDiffSectionGeometry` call inside the `sectionGeometry` `useMemo` and update it to pass `composer` as the ninth argument. Replace the relevant `useMemo` block (the one assigned to `sectionGeometry`) with:

```ts
const sectionGeometry = useMemo(
  () =>
    files.map((file, index) => {
      const notes = allAgentNotesByFile.get(file.id) ?? EMPTY_VISIBLE_AGENT_NOTES;
      const fileComposer = composer && composer.fileId === file.id ? composer : null;
      if (notes.length === 0 && !fileComposer) {
        return baseSectionGeometry[index]!;
      }

      return measureDiffSectionGeometry(
        file,
        layout,
        showHunkHeaders,
        theme,
        notes,
        diffContentWidth,
        showLineNumbers,
        wrapLines,
        fileComposer,
      );
    }),
  [
    allAgentNotesByFile,
    baseSectionGeometry,
    composer,
    diffContentWidth,
    files,
    layout,
    showHunkHeaders,
    showLineNumbers,
    theme,
    wrapLines,
  ],
);
```

Forward `commentCursorRowStableKey`, `composer`, and the composer callbacks to each `<DiffSection ... />` in the render branch. Inside the `files.map(...)` block, replace the `<DiffSection key={file.id} ... />` element with:

```ts
                  return (
                    <DiffSection
                      key={file.id}
                      codeHorizontalOffset={codeHorizontalOffset}
                      commentCursorRowStableKey={commentCursorRowStableKey ?? null}
                      composer={composer && composer.fileId === file.id ? composer : null}
                      file={file}
                      headerLabelWidth={headerLabelWidth}
                      headerStatsWidth={headerStatsWidth}
                      layout={layout}
                      selectedHunkIndex={file.id === selectedFileId ? selectedHunkIndex : -1}
                      shouldLoadHighlight={highlightPrefetchFileIds.has(file.id)}
                      sectionGeometry={sectionGeometry[index]}
                      separatorWidth={separatorWidth}
                      showHeader={shouldRenderInStreamFileHeader(index)}
                      showSeparator={index > 0}
                      showLineNumbers={showLineNumbers}
                      showHunkHeaders={showHunkHeaders}
                      wrapLines={wrapLines}
                      theme={theme}
                      viewWidth={diffContentWidth}
                      visibleAgentNotes={
                        visibleAgentNotesByFile.get(file.id) ?? EMPTY_VISIBLE_AGENT_NOTES
                      }
                      visibleBodyBounds={visibleBodyBoundsByFile.get(file.id)}
                      onCommentComposerCancel={onCommentComposerCancel}
                      onCommentComposerSubmit={onCommentComposerSubmit}
                      onOpenAgentNotesAtHunk={(hunkIndex) =>
                        onOpenAgentNotesAtHunk(file.id, hunkIndex)
                      }
                      onSelect={() => onSelectFile(file.id)}
                    />
                  );
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/panes/DiffPane.tsx src/ui/components/panes/DiffSection.tsx
git commit -m "feat(diff): plumb the comment cursor and composer through DiffPane and DiffSection"
```

---

### Task 10: `handleCursorShortcut` in the keyboard router

**Files:**

- Modify: `src/ui/hooks/useAppKeyboardShortcuts.ts`

- [ ] **Step 1: Extend the options interface**

In `src/ui/hooks/useAppKeyboardShortcuts.ts`, add new fields to `UseAppKeyboardShortcutsOptions`:

```ts
  commentCursorMode: "off" | "navigating" | "composing";
  enterCommentCursor: () => void;
  exitCommentCursor: () => void;
  moveCommentCursor: (delta: number) => void;
  jumpCommentCursorToHunk: (delta: number) => void;
  openCommentComposer: () => void;
```

Pull those fields out of the function parameters next to the existing ones.

- [ ] **Step 2: Add the cursor handler**

Add this helper inside `useAppKeyboardShortcuts`, between `handleMenuShortcut` and `handleFilterShortcut`:

```ts
const commentCursorModeRef = useRef(commentCursorMode);
commentCursorModeRef.current = commentCursorMode;

const handleCursorShortcut = (key: KeyEvent) => {
  const mode = commentCursorModeRef.current;

  if (mode === "off") {
    return false;
  }

  if (mode === "composing") {
    // The focused composer input owns its own keys; the router stays out of its way.
    return true;
  }

  if (isEscapeKey(key) || key.name === "c" || key.sequence === "c") {
    exitCommentCursor();
    return true;
  }

  if (key.name === "return" || key.name === "enter" || key.name === "i" || key.sequence === "i") {
    openCommentComposer();
    return true;
  }

  if (isStepUpKey(key)) {
    moveCommentCursor(-1);
    return true;
  }

  if (isStepDownKey(key)) {
    moveCommentCursor(1);
    return true;
  }

  if (key.name === "[") {
    jumpCommentCursorToHunk(-1);
    return true;
  }

  if (key.name === "]") {
    jumpCommentCursorToHunk(1);
    return true;
  }

  return false;
};
```

Add cursor entry to `handleAppShortcut`. Find the block that begins with `if (key.name === "a") {` and insert this new branch _before_ it:

```ts
if (key.name === "c" || key.sequence === "c") {
  runAndCloseMenu(enterCommentCursor);
  return;
}
```

Wire the new handler into the `useKeyboard` callback. Replace the existing callback body with:

```ts
useKeyboard((key: KeyEvent) => {
  if (handleMenuToggleShortcut(key)) {
    return;
  }

  if (pagerModeRef.current) {
    handlePagerShortcut(key);
    return;
  }

  if (handleHelpShortcut(key)) {
    return;
  }

  if (handleMenuShortcut(key)) {
    return;
  }

  if (handleCursorShortcut(key)) {
    return;
  }

  if (handleFilterShortcut(key)) {
    return;
  }

  handleAppShortcut(key);
});
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: FAIL — `App.tsx` does not yet pass the new options to `useAppKeyboardShortcuts`. Task 11 closes that gap. The error must be exactly about the new options; any other type error indicates a real problem in this task's edits.

- [ ] **Step 4: Commit**

```bash
git add src/ui/hooks/useAppKeyboardShortcuts.ts
git commit -m "feat(keys): add cursor-mode handler to the app keyboard router"
```

---

### Task 11: Wire cursor state into `App.tsx`

**Files:**

- Modify: `src/ui/App.tsx`
- Modify: `src/ui/lib/appMenus.ts`

- [ ] **Step 1: Pull cursor controls out of the review controller**

In `src/ui/App.tsx`, near the existing `review.*` destructure (around line 124-130), add:

```ts
const commentCursor = review.commentCursor;
const commentCursorRowStableKey = review.commentCursorRowStableKey;
const addUserLiveComment = review.addUserLiveComment;
const setCommentCursorMode = review.setCommentCursorMode;
const moveCommentCursor = review.moveCommentCursor;
const jumpCommentCursorToHunk = review.jumpCommentCursorToHunk;
```

- [ ] **Step 2: Build the composer descriptor and callbacks**

Below the destructure above, add:

```ts
const composerDescriptor =
  commentCursor.mode === "composing"
    ? {
        fileId: commentCursor.fileId,
        hunkIndex: commentCursor.hunkIndex,
        side: commentCursor.side,
        line: commentCursor.line,
      }
    : null;

const enterCommentCursor = useCallback(() => {
  setCommentCursorMode(commentCursor.mode === "off" ? "navigating" : "off");
}, [commentCursor.mode, setCommentCursorMode]);

const exitCommentCursor = useCallback(() => {
  setCommentCursorMode("off");
}, [setCommentCursorMode]);

const openCommentComposer = useCallback(() => {
  setCommentCursorMode("composing");
}, [setCommentCursorMode]);

const cancelCommentComposer = useCallback(() => {
  setCommentCursorMode("navigating");
}, [setCommentCursorMode]);

const submitCommentComposer = useCallback(
  (summary: string) => {
    try {
      addUserLiveComment(
        {
          fileId: commentCursor.fileId,
          hunkIndex: commentCursor.hunkIndex,
          side: commentCursor.side,
          line: commentCursor.line,
        },
        summary,
      );
    } catch (error) {
      console.error("Failed to add user comment.", error);
    } finally {
      setCommentCursorMode("navigating");
    }
  },
  [
    addUserLiveComment,
    commentCursor.fileId,
    commentCursor.hunkIndex,
    commentCursor.line,
    commentCursor.side,
    setCommentCursorMode,
  ],
);
```

- [ ] **Step 3: Pass cursor and composer through to `DiffPane`**

Find the existing `<DiffPane ... />` element near the bottom of `App.tsx`. Add the new props:

```ts
        <DiffPane
          codeHorizontalOffset={codeHorizontalOffset}
          commentCursorRowStableKey={commentCursorRowStableKey}
          composer={composerDescriptor}
          diffContentWidth={diffContentWidth}
          files={filteredFiles}
          pagerMode={pagerMode}
          headerLabelWidth={diffHeaderLabelWidth}
          headerStatsWidth={diffHeaderStatsWidth}
          layout={resolvedLayout}
          scrollRef={diffScrollRef}
          selectedFileId={selectedFile?.id}
          selectedHunkIndex={selectedHunkIndex}
          scrollToNote={review.scrollToNote}
          separatorWidth={diffSeparatorWidth}
          showAgentNotes={showAgentNotes}
          showLineNumbers={showLineNumbers}
          showHunkHeaders={showHunkHeaders}
          wrapLines={wrapLines}
          wrapToggleScrollTop={wrapToggleScrollTopRef.current}
          layoutToggleScrollTop={layoutToggleScrollTopRef.current}
          layoutToggleRequestId={layoutToggleRequestId}
          selectedFileTopAlignRequestId={review.selectedFileTopAlignRequestId}
          selectedHunkRevealRequestId={review.selectedHunkRevealRequestId}
          theme={activeTheme}
          width={diffPaneWidth}
          onCommentComposerCancel={cancelCommentComposer}
          onCommentComposerSubmit={submitCommentComposer}
          onOpenAgentNotesAtHunk={openAgentNotesAtHunk}
          onScrollCodeHorizontally={(delta) => {
            scrollCodeHorizontally(delta * FAST_CODE_HORIZONTAL_SCROLL_COLUMNS);
          }}
          onSelectFile={jumpToFile}
          onViewportCenteredHunkChange={(fileId, hunkIndex) =>
            review.selectHunk(fileId, hunkIndex, { preserveViewport: true })
          }
        />
```

- [ ] **Step 4: Wire the keyboard hook**

In the `useAppKeyboardShortcuts({ ... })` call near the bottom of `App.tsx`, add the new options:

```ts
    commentCursorMode: commentCursor.mode,
    enterCommentCursor,
    exitCommentCursor,
    moveCommentCursor,
    jumpCommentCursorToHunk,
    openCommentComposer,
```

- [ ] **Step 5: Add the View menu entry**

In `src/ui/lib/appMenus.ts`, extend `BuildAppMenusOptions` with:

```ts
  commentCursorMode: "off" | "navigating" | "composing";
  toggleCommentCursor: () => void;
```

Pull those fields out of the parameters at the top of `buildAppMenus`. Add an entry to the `view` menu — append the following item after the existing `Hunk metadata` entry:

```ts
      {
        kind: "item",
        label: "Comment cursor",
        hint: "c",
        checked: commentCursorMode !== "off",
        action: toggleCommentCursor,
      },
```

- [ ] **Step 6: Pass the new menu inputs from `App.tsx`**

In `App.tsx`, locate the `useMemo` for `menus = useMemo(() => buildAppMenus({ ... }))`. Add to the call:

```ts
        commentCursorMode: commentCursor.mode,
        toggleCommentCursor: enterCommentCursor,
```

Add `commentCursor.mode` and `enterCommentCursor` to the `useMemo` dependency array.

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Run tests**

Run: `bun test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/ui/App.tsx src/ui/lib/appMenus.ts
git commit -m "feat(app): wire the comment cursor into App, DiffPane, and the view menu"
```

---

### Task 12: AppHost interaction tests

**Files:**

- Modify: `src/ui/AppHost.interactions.test.tsx`

- [ ] **Step 1: Add the failing tests**

Append the following block inside the `describe("App interactions", ...)` block in `src/ui/AppHost.interactions.test.tsx`:

```ts
  test("comment cursor toggles, navigates, and saves a user comment", async () => {
    const setup = await testRender(<AppHost bootstrap={createSingleFileBootstrap()} />, {
      width: 200,
      height: 28,
    });

    try {
      await flush(setup);

      // Enter cursor mode.
      await act(async () => {
        await setup.mockInput.typeText("c");
      });
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("▶");

      // Open the composer.
      await act(async () => {
        await setup.mockInput.typeText("i");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).toContain("Comment ·");
      expect(frame).toContain("Enter save · Esc cancel");

      // Type and submit a comment.
      await act(async () => {
        await setup.mockInput.typeText("Look at this");
      });
      await act(async () => {
        await setup.mockInput.pressKey({ name: "return" });
      });
      await flush(setup);

      frame = await waitForFrame(setup, (next) => next.includes("Look at this"));
      expect(frame).toContain("Look at this");

      // Esc leaves cursor mode.
      await act(async () => {
        await setup.mockInput.pressKey({ name: "escape" });
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).not.toContain("▶");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("comment composer Esc discards the draft without saving", async () => {
    const setup = await testRender(<AppHost bootstrap={createSingleFileBootstrap()} />, {
      width: 200,
      height: 28,
    });

    try {
      await flush(setup);

      await act(async () => {
        await setup.mockInput.typeText("c");
      });
      await flush(setup);

      await act(async () => {
        await setup.mockInput.typeText("i");
      });
      await flush(setup);

      await act(async () => {
        await setup.mockInput.typeText("draft");
      });
      await flush(setup);

      await act(async () => {
        await setup.mockInput.pressKey({ name: "escape" });
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("Comment ·");
      // Comment was not saved — no note card with the draft text appears.
      expect(frame).not.toContain("draft");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
```

- [ ] **Step 2: Run the new tests to verify they pass**

Run: `bun test src/ui/AppHost.interactions.test.tsx`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/ui/AppHost.interactions.test.tsx
git commit -m "test(app): cover the comment cursor toggle, composer, and save flow"
```

---

### Task 13: PTY integration coverage

**Files:**

- Create: `test/pty/comment-cursor-integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `test/pty/comment-cursor-integration.test.ts`:

```ts
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("comment cursor PTY integration", () => {
  test("user can open the cursor, write a comment, and see it as a note", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 140,
      rows: 28,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await session.press("c");
      const withCursor = await harness.waitForSnapshot(
        session,
        (text) => text.includes("▶"),
        5_000,
      );
      expect(withCursor).toContain("▶");

      await session.press("i");
      const composing = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Comment ·"),
        5_000,
      );
      expect(composing).toContain("Comment ·");

      await session.type("PTY review note");
      await session.press("return");

      const saved = await harness.waitForSnapshot(
        session,
        (text) => text.includes("PTY review note"),
        5_000,
      );
      expect(saved).toContain("PTY review note");
    } finally {
      session.close();
    }
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun run test:integration -- comment-cursor-integration`
Expected: PASS.

If the harness does not expose `session.type`, replace `session.type("PTY review note")` with character-by-character `session.press(...)` calls (consult `test/pty/harness.ts` for the exact session API and use whichever method types raw text).

- [ ] **Step 3: Commit**

```bash
git add test/pty/comment-cursor-integration.test.ts
git commit -m "test(pty): cover the comment cursor end-to-end through a real PTY"
```

---

### Task 14: Changelog entry

**Files:**

- Modify: `CHANGELOG.md`

- [ ] **Step 1: Record the feature**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, add:

```md
- Added a keyboard-driven comment cursor (`c`) so reviewers can mark a diff row, type a single-line note with `i` / Enter, and persist it as a user-authored review comment that agents pick up through the existing `hunk session comment *` commands.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): note the comment cursor UI under Unreleased > Added"
```

---

### Task 15: Final verification gates

**Files:** (no edits — verification only)

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 2: Unit tests**

Run: `bun test`
Expected: PASS.

- [ ] **Step 3: PTY integration tests**

Run: `bun run test:integration`
Expected: PASS.

- [ ] **Step 4: TTY smoke**

Run: `bun run test:tty-smoke`
Expected: PASS.

- [ ] **Step 5: Real TTY smoke run**

Manually run the source CLI on a sample diff and verify:

```bash
bun run src/main.tsx -- diff
# In the TUI:
#  press `c` — a cursor marker appears on the first eligible row of the selected hunk
#  press `j` then `[` — the cursor moves rows and jumps to the previous hunk
#  press `i` — the composer card appears under the cursor row, focused
#  type a note, press Enter — the composer closes and the note renders inline
#  press Esc — cursor mode exits cleanly
```

Expected: every step above matches reality. Capture any visual regression as a follow-up fix before reporting the work complete.

- [ ] **Step 6: Final summary**

Confirm in the PR description that:

- `bun run typecheck` passed.
- `bun test` passed.
- `bun run test:integration` passed.
- `bun run test:tty-smoke` passed.
- A real TTY smoke run on a sample diff produced the expected cursor + composer + saved-comment behaviour.
