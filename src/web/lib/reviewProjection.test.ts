import { describe, expect, test } from "bun:test";
import type { ReviewNoteV1 } from "../../core/review/types";
import { projectVisibleBrowserReview } from "./reviewProjection";
import type { BrowserReviewDocument, BrowserReviewFile } from "./reviewTypes";

function note(id: string, fileKey: string, source: ReviewNoteV1["source"]): ReviewNoteV1 {
  return {
    id,
    fileKey,
    source,
    origin: source === "user" ? "user" : "live-agent",
    anchor: { intersectingHunkIndices: [] },
    summary: id,
    editable: source === "user",
  };
}
function file(key: string, path: string, agentSummary?: string): BrowserReviewFile {
  return {
    key,
    runtimeId: key,
    path,
    changeKind: "change",
    agentSummary,
    additions: 1,
    deletions: 0,
    statsTruncated: false,
    hunkCount: 0,
    flags: { untracked: false, binary: false, tooLarge: false, partial: true },
    patchResourceId: `patch:${key}`,
    canonicalResourceId: `canonical:${key}`,
    sourceResourceIds: {},
    hunks: [],
    notes: [note(`agent:${key}`, key, "agent"), note(`user:${key}`, key, "user")],
  };
}
const files = [
  file("a", "alpha.ts"),
  file("b", "beta.ts", "needle rationale"),
  file("c", "charlie.ts"),
];
const document: BrowserReviewDocument = {
  version: 1,
  generation: "generation:test",
  documentIdentity: "review:test",
  changesetId: "changes:test",
  title: "Review",
  sourceLabel: "test",
  files,
  resources: [],
  capabilities: { actions: [] },
};

describe("browser semantic projection", () => {
  test("shares agent-summary filtering, source visibility, and authoritative order", () => {
    const projected = projectVisibleBrowserReview(document, {
      filter: "needle",
      showAgentNotes: false,
      notes: [note("mutable-agent", "b", "agent"), note("mutable-user", "b", "user")],
    });
    expect(projected.files.map((entry) => entry.key)).toEqual(["b"]);
    expect(projected.files[0]!.notes.map((entry) => entry.id)).toEqual(["user:b"]);
    expect(projected.mutableNotes.map((entry) => entry.id)).toEqual(["mutable-user"]);
  });

  test("keeps document order when multiple path/summary matches remain", () => {
    const projected = projectVisibleBrowserReview(document, {
      filter: ".ts",
      showAgentNotes: true,
      notes: [],
    });
    expect(projected.files.map((entry) => entry.key)).toEqual(["a", "b", "c"]);
  });
});
