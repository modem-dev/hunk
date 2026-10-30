import { describe, expect, test } from "bun:test";
import { createGuardedReviewNavigation } from "./extensionNavigation";

/** One navigable file with the given number of parsed hunks. */
function createTestNavigableFile(id: string, hunkCount: number) {
  return { id, metadata: { hunks: Array.from({ length: hunkCount }, () => ({})) } };
}

function createTestNavigation(options?: {
  files?: ReturnType<typeof createTestNavigableFile>[];
  onSelectFile?: (fileId: string) => void;
  onSelectHunk?: (fileId: string, hunkIndex: number) => void;
  revealResult?: "line" | "hunk" | "none";
}) {
  const warnings: string[] = [];
  const selectedFiles: string[] = [];
  const selectedHunks: Array<[string, number]> = [];
  const revealedLines: Array<[string, string, number]> = [];
  let files = options?.files ?? [createTestNavigableFile("a", 3)];

  const navigation = createGuardedReviewNavigation({
    extensionId: "triage",
    getFiles: () => files,
    notify: (message, type) => {
      if (type === "warning") {
        warnings.push(message);
      }
    },
    onSelectFile: options?.onSelectFile ?? ((fileId) => selectedFiles.push(fileId)),
    onSelectHunk:
      options?.onSelectHunk ?? ((fileId, hunkIndex) => selectedHunks.push([fileId, hunkIndex])),
    onRevealLine: (fileId, side, line) => {
      revealedLines.push([fileId, side, line]);
      return options?.revealResult ?? "line";
    },
  });

  return {
    navigation,
    warnings,
    selectedFiles,
    selectedHunks,
    revealedLines,
    setFiles(next: ReturnType<typeof createTestNavigableFile>[]) {
      files = next;
    },
  };
}

describe("createGuardedReviewNavigation", () => {
  test("routes a visible-file selection through to the host callback", () => {
    const { navigation, selectedFiles, warnings } = createTestNavigation();

    navigation.selectFile("a");

    expect(selectedFiles).toEqual(["a"]);
    expect(warnings).toEqual([]);
  });

  test("refuses a file id the review stream cannot show, with a warning", () => {
    const { navigation, selectedFiles, warnings } = createTestNavigation();

    navigation.selectFile("hidden");

    expect(selectedFiles).toEqual([]);
    expect(warnings).toEqual(['Extension triage selectFile targeted unknown file id "hidden"']);
  });

  test("clamps a hunk index into the file's real range and floors fractions", () => {
    const { navigation, selectedHunks } = createTestNavigation();

    navigation.selectHunk("a", 99);
    navigation.selectHunk("a", -5);
    navigation.selectHunk("a", 1.7);

    expect(selectedHunks).toEqual([
      ["a", 2],
      ["a", 0],
      ["a", 1],
    ]);
  });

  test("refuses a non-numeric hunk index instead of passing garbage through", () => {
    const { navigation, selectedHunks, warnings } = createTestNavigation();

    navigation.selectHunk("a", Number.NaN);
    navigation.selectHunk("a", "2" as unknown as number);

    expect(selectedHunks).toEqual([]);
    expect(warnings).toEqual([
      'Extension triage selectHunk received an invalid hunk index for "a"',
      'Extension triage selectHunk received an invalid hunk index for "a"',
    ]);
  });

  test("turns a host-callback failure into a warning naming the extension", () => {
    const { navigation, warnings } = createTestNavigation({
      onSelectFile: () => {
        throw new Error("controller unavailable");
      },
    });

    navigation.selectFile("a");

    expect(warnings).toEqual(["Extension triage failed selectFile • controller unavailable"]);
  });

  test("refuses every call once the review surface it was minted for is gone", () => {
    // A hard session reload (`resetApp`) remounts the app under an in-flight
    // handler; its navigation must say so rather than silently no-op against
    // the dead instance or judge targets by the old review's file list.
    let alive = true;
    const warnings: string[] = [];
    const selectedFiles: string[] = [];
    const navigation = createGuardedReviewNavigation({
      extensionId: "triage",
      getFiles: () => [createTestNavigableFile("a", 1)],
      isLive: () => alive,
      notify: (message, type) => {
        if (type === "warning") {
          warnings.push(message);
        }
      },
      onSelectFile: (fileId) => selectedFiles.push(fileId),
      onSelectHunk: () => {},
      onRevealLine: () => "line",
    });

    navigation.selectFile("a");
    alive = false;
    navigation.selectFile("a");
    navigation.selectHunk("a", 0);
    navigation.revealLine("a", "new", 1);

    expect(selectedFiles).toEqual(["a"]);
    expect(warnings).toEqual([
      "Extension triage selectFile ignored — the review session was reloaded",
      "Extension triage selectHunk ignored — the review session was reloaded",
      "Extension triage revealLine ignored — the review session was reloaded",
    ]);
  });

  test("routes a line reveal on a visible file through to the host callback", () => {
    const { navigation, revealedLines, warnings } = createTestNavigation();

    navigation.revealLine("a", "old", 211);

    expect(revealedLines).toEqual([["a", "old", 211]]);
    expect(warnings).toEqual([]);
  });

  test("refuses a line reveal on a file the review stream cannot show", () => {
    const { navigation, revealedLines, warnings } = createTestNavigation();

    navigation.revealLine("hidden", "new", 4);

    expect(revealedLines).toEqual([]);
    expect(warnings).toEqual(['Extension triage revealLine targeted unknown file id "hidden"']);
  });

  test("refuses a side outside the two diff sides", () => {
    const { navigation, revealedLines, warnings } = createTestNavigation();

    navigation.revealLine("a", "both" as unknown as "new", 4);

    expect(revealedLines).toEqual([]);
    expect(warnings).toEqual(['Extension triage revealLine received an invalid side for "a"']);
  });

  test("refuses a line number that is not a 1-based whole line", () => {
    // Patches number lines from 1 upward; a fraction, a zero, or a string is a caller bug,
    // not a line the review merely failed to find.
    const { navigation, revealedLines, warnings } = createTestNavigation();

    navigation.revealLine("a", "new", 0);
    navigation.revealLine("a", "new", -3);
    navigation.revealLine("a", "new", 2.5);
    navigation.revealLine("a", "new", Number.NaN);
    navigation.revealLine("a", "new", "4" as unknown as number);

    expect(revealedLines).toEqual([]);
    expect(warnings).toEqual(
      Array.from(
        { length: 5 },
        () => 'Extension triage revealLine received an invalid line number for "a"',
      ),
    );
  });

  test("stays quiet when the host falls back to the hunk containing the line", () => {
    // A line inside a collapsed gap has no row to scroll to; landing on its hunk is the
    // honest best effort, not a failure worth a toast.
    const { navigation, warnings } = createTestNavigation({ revealResult: "hunk" });

    navigation.revealLine("a", "new", 42);

    expect(warnings).toEqual([]);
  });

  test("warns when no hunk of the file covers the requested line", () => {
    const { navigation, warnings } = createTestNavigation({ revealResult: "none" });

    navigation.revealLine("a", "new", 9001);

    expect(warnings).toEqual(['Extension triage revealLine found no new line 9001 in "a"']);
  });

  test("validates against the files visible at call time, not at creation", () => {
    // A command handler may await a dialog while a reload or filter changes
    // the review; navigation must judge the target against the current list.
    const { navigation, selectedFiles, warnings, setFiles } = createTestNavigation();

    setFiles([createTestNavigableFile("b", 1)]);
    navigation.selectFile("a");
    navigation.selectFile("b");

    expect(selectedFiles).toEqual(["b"]);
    expect(warnings).toEqual(['Extension triage selectFile targeted unknown file id "a"']);
  });
});
