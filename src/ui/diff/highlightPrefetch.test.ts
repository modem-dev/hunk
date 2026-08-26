import { describe, expect, jest, mock, test } from "bun:test";
import type { DiffFile } from "../../core/changeset/model";
import { buildFileSectionLayouts } from "../lib/fileSectionLayout";
import { resolveTheme } from "../themes";
import {
  buildHighlightPrefetchPlan,
  prefetchImmediateHighlightedFiles,
  scheduleSpeculativeHighlightedFiles,
  type HighlightPrefetch,
} from "./highlightPrefetch";

/** Build file identities sufficient for highlight policy and scheduler tests. */
function createFiles(count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `file-${index}` })) as DiffFile[];
}

/** Build exact highlight sets for one selection and viewport without loading the real highlighter. */
function createHighlightPlan({
  files,
  layouts,
  scrollTop,
  selectedFileId,
  viewportHeight = 5,
}: {
  files: DiffFile[];
  layouts: ReturnType<typeof buildFileSectionLayouts>;
  scrollTop: number;
  selectedFileId?: string;
  viewportHeight?: number;
}) {
  return buildHighlightPrefetchPlan({
    files,
    fileSectionLayouts: layouts,
    rapidScrollOverscanRows: 0,
    scrollTop,
    selectedFileId,
    viewportHeight,
  });
}

/** Resolve speculative calls in review-file dispatch order. */
function expectedSpeculativeIds(files: DiffFile[], speculativeFileIds: ReadonlySet<string>) {
  return files.filter((file) => speculativeFileIds.has(file.id)).map((file) => file.id);
}

/** Read file ids from one injected prefetch mock. */
function prefetchedIds(prefetch: ReturnType<typeof mock<HighlightPrefetch>>) {
  return prefetch.mock.calls.map(([options]) => options.file.id);
}

describe("highlight prefetch scheduling", () => {
  test("dispatches selected and initially visible files immediately with worker offload", () => {
    const files = createFiles(8);
    const layouts = buildFileSectionLayouts(
      files,
      files.map(() => 10),
    );
    const theme = resolveTheme("github-dark-default", null);
    const plan = createHighlightPlan({
      files,
      layouts,
      scrollTop: 0,
      selectedFileId: files[6]!.id,
    });
    const prefetch = mock<HighlightPrefetch>(() => undefined);

    expect(
      [...plan.immediateFileIds].filter((fileId) => plan.speculativeFileIds.has(fileId)),
    ).toEqual([]);

    prefetchImmediateHighlightedFiles({
      files,
      immediateFileIds: plan.immediateFileIds,
      offloadLargeDiff: true,
      prefetch,
      theme,
    });

    expect(prefetchedIds(prefetch)).toEqual([files[0]!.id, files[6]!.id]);
    expect(prefetch.mock.calls.every(([options]) => options.offloadLargeDiff)).toBe(true);
  });

  test("keeps speculative highlighting quiet until the 300 ms idle boundary", () => {
    jest.useFakeTimers();
    const files = createFiles(8);
    const layouts = buildFileSectionLayouts(
      files,
      files.map(() => 10),
    );
    const theme = resolveTheme("github-dark-default", null);
    const plan = createHighlightPlan({ files, layouts, scrollTop: 0 });
    const prefetch = mock<HighlightPrefetch>(() => undefined);
    let cancel = () => {};

    try {
      cancel = scheduleSpeculativeHighlightedFiles({
        files,
        offloadLargeDiff: true,
        prefetch,
        speculativeFileIds: plan.speculativeFileIds,
        theme,
      });

      jest.advanceTimersByTime(299);
      expect(prefetch).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(prefetchedIds(prefetch)).toEqual(
        expectedSpeculativeIds(files, plan.speculativeFileIds),
      );
      expect(prefetch.mock.calls.every(([options]) => options.offloadLargeDiff)).toBe(true);

      cancel();
      const completedCalls = prefetch.mock.calls.length;
      jest.advanceTimersByTime(1_000);
      expect(prefetch).toHaveBeenCalledTimes(completedCalls);
    } finally {
      cancel();
      jest.useRealTimers();
    }
  });

  test("does not allocate a timer when the plan has no speculative-only work", () => {
    jest.useFakeTimers();
    const files = createFiles(1);
    const layouts = buildFileSectionLayouts(files, [10]);
    const theme = resolveTheme("github-dark-default", null);
    const plan = createHighlightPlan({
      files,
      layouts,
      scrollTop: 0,
      selectedFileId: files[0]!.id,
      viewportHeight: 10,
    });
    const prefetch = mock<HighlightPrefetch>(() => undefined);
    const initialTimerCount = jest.getTimerCount();
    let cancel = () => {};

    try {
      expect(plan.speculativeFileIds.size).toBe(0);
      cancel = scheduleSpeculativeHighlightedFiles({
        files,
        offloadLargeDiff: true,
        prefetch,
        speculativeFileIds: plan.speculativeFileIds,
        theme,
      });

      expect(jest.getTimerCount()).toBe(initialTimerCount);
      jest.advanceTimersByTime(301);
      expect(prefetch).not.toHaveBeenCalled();
      cancel();
    } finally {
      cancel();
      jest.useRealTimers();
    }
  });

  test("selection changes cancel the old halo and start a fresh 300 ms deadline", () => {
    jest.useFakeTimers();
    const files = createFiles(8);
    const layouts = buildFileSectionLayouts(
      files,
      files.map(() => 10),
    );
    const theme = resolveTheme("github-dark-default", null);
    const oldPlan = createHighlightPlan({
      files,
      layouts,
      scrollTop: 0,
      selectedFileId: files[1]!.id,
    });
    const newPlan = createHighlightPlan({
      files,
      layouts,
      scrollTop: 0,
      selectedFileId: files[6]!.id,
    });
    const expectedNewIds = expectedSpeculativeIds(files, newPlan.speculativeFileIds);
    const prefetch = mock<HighlightPrefetch>(() => undefined);
    let cancelOld = () => {};
    let cancelNew = () => {};

    try {
      cancelOld = scheduleSpeculativeHighlightedFiles({
        files,
        offloadLargeDiff: true,
        prefetch,
        speculativeFileIds: oldPlan.speculativeFileIds,
        theme,
      });

      jest.advanceTimersByTime(100);
      cancelOld();
      cancelNew = scheduleSpeculativeHighlightedFiles({
        files,
        offloadLargeDiff: true,
        prefetch,
        speculativeFileIds: newPlan.speculativeFileIds,
        theme,
      });

      // Total t=300: the cancelled selection's original deadline must do no work.
      jest.advanceTimersByTime(200);
      expect(prefetch).not.toHaveBeenCalled();

      // Total t=399: the new selection has been idle for only 299 ms.
      jest.advanceTimersByTime(99);
      expect(prefetch).not.toHaveBeenCalled();

      // Total t=400: exactly 300 ms after the selection change, only the new halo starts.
      jest.advanceTimersByTime(1);
      expect(prefetchedIds(prefetch)).toEqual(expectedNewIds);
      expect(prefetch.mock.calls.every(([options]) => options.offloadLargeDiff)).toBe(true);

      cancelNew();
      const completedCalls = prefetch.mock.calls.length;
      jest.advanceTimersByTime(1_000);
      expect(prefetch).toHaveBeenCalledTimes(completedCalls);
    } finally {
      cancelNew();
      cancelOld();
      jest.useRealTimers();
    }
  });

  test("viewport changes cancel the old halo before scheduling the new viewport", () => {
    jest.useFakeTimers();
    const files = createFiles(12);
    const layouts = buildFileSectionLayouts(
      files,
      files.map(() => 10),
    );
    const theme = resolveTheme("github-dark-default", null);
    const oldPlan = createHighlightPlan({ files, layouts, scrollTop: 0 });
    const newPlan = createHighlightPlan({
      files,
      layouts,
      scrollTop: layouts[8]!.bodyTop,
    });
    const expectedNewIds = expectedSpeculativeIds(files, newPlan.speculativeFileIds);
    const prefetch = mock<HighlightPrefetch>(() => undefined);
    let cancelOld = () => {};
    let cancelNew = () => {};

    try {
      cancelOld = scheduleSpeculativeHighlightedFiles({
        files,
        offloadLargeDiff: true,
        prefetch,
        speculativeFileIds: oldPlan.speculativeFileIds,
        theme,
      });

      jest.advanceTimersByTime(100);
      cancelOld();
      cancelNew = scheduleSpeculativeHighlightedFiles({
        files,
        offloadLargeDiff: true,
        prefetch,
        speculativeFileIds: newPlan.speculativeFileIds,
        theme,
      });

      jest.advanceTimersByTime(299);
      expect(prefetch).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(prefetchedIds(prefetch)).toEqual(expectedNewIds);

      cancelNew();
      const completedCalls = prefetch.mock.calls.length;
      jest.advanceTimersByTime(1_000);
      expect(prefetch).toHaveBeenCalledTimes(completedCalls);
    } finally {
      cancelNew();
      cancelOld();
      jest.useRealTimers();
    }
  });
});
