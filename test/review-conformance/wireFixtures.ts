/**
 * The wire corpus: what a client may say, and what it means once said.
 *
 * Every action in the vocabulary appears here with the intent it lowers to, written by
 * hand. That makes the corpus a statement of the round trip rather than a snapshot of the
 * parser: an action that stopped lowering to the intent it derives from fails here, which
 * is the B12 failure mode of a wire type drifting away from the semantics it carries.
 *
 * The adversarial cases are the two the audit contributed. B10: a line inside an expanded
 * gap is addressable at all, because the action carries the proof for it. D1 is covered by
 * the note-size corpus, which the wire now runs as a consumer.
 */
import type { ReviewWireFixture } from "./types";

const FILE_KEY = "file:0123456789abcdef";
const GAP_ID = "before:1";
const SOURCE_IDENTITY = "source:0123456789abcdef";

export const REVIEW_WIRE_FIXTURES: readonly ReviewWireFixture[] = [
  {
    id: "select-hunk",
    findings: ["B12"],
    description: "Selecting one hunk, with the reveal the caller wants stated explicitly.",
    action: {
      type: "selection/select",
      fileKey: FILE_KEY,
      hunkIndex: 2,
      reveal: { anchor: "hunk", scrollToNote: false },
    },
    expected: {
      accepted: true,
      intent: {
        type: "selection/select",
        fileKey: FILE_KEY,
        hunkIndex: 2,
        reveal: { anchor: "hunk", scrollToNote: false },
      },
    },
  },
  {
    id: "move-annotated-hunk-backwards",
    findings: ["B12"],
    description: "Relative navigation, whose scope and wrap policy are core's to decide.",
    action: { type: "selection/move", scope: "annotated-hunk", delta: -1 },
    expected: {
      accepted: true,
      intent: { type: "selection/move", scope: "annotated-hunk", delta: -1 },
    },
  },
  {
    id: "select-file",
    findings: ["B12"],
    description: "A file jump with no reveal stated; the file-jump rule supplies one.",
    action: { type: "selection/select-file", fileKey: FILE_KEY },
    expected: { accepted: true, intent: { type: "selection/select-file", fileKey: FILE_KEY } },
  },
  {
    id: "anchor-selection",
    findings: ["B12"],
    description: "Adopting the position a remote viewport settled on, which moves no viewport.",
    action: { type: "selection/anchor", fileKey: FILE_KEY, hunkIndex: 0 },
    expected: {
      accepted: true,
      intent: { type: "selection/anchor", fileKey: FILE_KEY, hunkIndex: 0 },
    },
  },
  {
    id: "set-filter",
    findings: ["B12"],
    description: "Filtering is shared review state, so it travels as an action.",
    action: { type: "filter/set", filter: "src/ui" },
    expected: { accepted: true, intent: { type: "filter/set", filter: "src/ui" } },
  },
  {
    id: "set-note-visibility",
    findings: ["B12"],
    description: "Note-layer visibility, likewise shared.",
    action: { type: "notes/set-visibility", visible: true },
    expected: { accepted: true, intent: { type: "notes/set-visibility", visible: true } },
  },
  {
    id: "start-draft-on-a-hunk",
    findings: ["B12"],
    description: "Opening a draft with no line stated; the whole-hunk default supplies one.",
    action: { type: "notes/start-draft", fileKey: FILE_KEY, hunkIndex: 1 },
    expected: {
      accepted: true,
      intent: { type: "notes/start-draft", fileKey: FILE_KEY, hunkIndex: 1 },
    },
  },
  {
    id: "start-edit-draft",
    findings: ["B12"],
    description: "Opening one saved reviewer note for identity-preserving editing.",
    action: { type: "notes/start-edit", noteId: "user:1" },
    expected: { accepted: true, intent: { type: "notes/start-edit", noteId: "user:1" } },
  },
  {
    id: "start-reply-draft",
    findings: ["B12"],
    description: "Opening a reply composer beneath one semantically stored note.",
    action: { type: "notes/start-reply", noteId: "live:1" },
    expected: { accepted: true, intent: { type: "notes/start-reply", noteId: "live:1" } },
  },
  {
    id: "update-draft-body",
    findings: ["B12"],
    description: "Transporting composer text through the shared semantic path.",
    action: { type: "notes/update-draft", body: "A remote reply" },
    expected: {
      accepted: true,
      intent: { type: "notes/update-draft", body: "A remote reply" },
    },
  },
  {
    id: "cancel-draft",
    findings: ["B12"],
    description: "Cancelling the one active shared composer.",
    action: { type: "notes/cancel-draft" },
    expected: { accepted: true, intent: { type: "notes/cancel-draft" } },
  },
  {
    id: "start-draft-on-an-expanded-line",
    findings: ["B10"],
    description:
      "A draft on a line the patch does not contain, carrying the proof that makes it addressable — the case the prototype's browser could not express at all.",
    action: {
      type: "notes/start-draft",
      fileKey: FILE_KEY,
      hunkIndex: 1,
      target: { side: "new", line: 7 },
      expandedLineProof: {
        gapId: GAP_ID,
        side: "new",
        line: 7,
        sourceIdentity: SOURCE_IDENTITY,
      },
    },
    // The proof is evidence for the producer, not part of the intent: what core plans is a
    // draft at a line, and the anchor path decides which hunk ends up owning it.
    expected: {
      accepted: true,
      intent: {
        type: "notes/start-draft",
        fileKey: FILE_KEY,
        hunkIndex: 1,
        target: { side: "new", line: 7 },
      },
    },
  },
  {
    id: "start-draft-with-a-proof-about-nothing",
    findings: ["B10"],
    description: "Evidence for a line the action does not name is malformed, not tolerated.",
    action: {
      type: "notes/start-draft",
      fileKey: FILE_KEY,
      hunkIndex: 1,
      expandedLineProof: {
        gapId: GAP_ID,
        side: "new",
        line: 7,
        sourceIdentity: SOURCE_IDENTITY,
      },
    },
    expected: { accepted: false },
  },
  {
    id: "create-user-note",
    findings: ["B12"],
    description: "Persisting the active draft, with no precondition on where it sits.",
    action: { type: "notes/create-user", consumeDraft: true },
    expected: { accepted: true, intent: { type: "notes/create-user", consumeDraft: true } },
  },
  {
    id: "update-user-note",
    findings: ["B12"],
    description: "Committing an edit against the same saved reviewer note.",
    action: { type: "notes/update-user", noteId: "user:1", consumeDraft: true },
    expected: {
      accepted: true,
      intent: { type: "notes/update-user", noteId: "user:1", consumeDraft: true },
    },
  },
  {
    id: "create-user-note-at-an-expanded-line",
    findings: ["B10"],
    description:
      "Saving the draft opened on an expanded line, restating where it is as a precondition so two clients cannot save each other's drafts.",
    action: {
      type: "notes/create-user",
      consumeDraft: true,
      target: { side: "new", line: 7 },
      expandedLineProof: {
        gapId: GAP_ID,
        side: "new",
        line: 7,
        sourceIdentity: SOURCE_IDENTITY,
      },
    },
    expected: { accepted: true, intent: { type: "notes/create-user", consumeDraft: true } },
  },
  {
    id: "remove-user-note",
    findings: ["B12"],
    description: "Removing one note the reviewer wrote.",
    action: { type: "notes/remove-user", noteId: "user:1" },
    expected: { accepted: true, intent: { type: "notes/remove-user", noteId: "user:1" } },
  },
  {
    id: "remove-live-note",
    findings: ["B12"],
    description: "Removing one note an agent contributed.",
    action: { type: "notes/remove-live", noteId: "live:1" },
    expected: { accepted: true, intent: { type: "notes/remove-live", noteId: "live:1" } },
  },
  {
    id: "clear-notes-for-one-file",
    findings: ["B12"],
    description: "A scoped clear, including the reviewer's own notes.",
    action: { type: "notes/clear", fileKey: FILE_KEY, includeUser: true },
    expected: {
      accepted: true,
      intent: { type: "notes/clear", fileKey: FILE_KEY, includeUser: true },
    },
  },
  {
    id: "toggle-gap",
    findings: ["B12"],
    description: "Expanding one addressable collapsed gap.",
    action: { type: "expansion/toggle", fileKey: FILE_KEY, gapId: GAP_ID },
    expected: {
      accepted: true,
      intent: { type: "expansion/toggle", fileKey: FILE_KEY, gapId: GAP_ID },
    },
  },
  {
    id: "unknown-field-on-a-known-action",
    findings: ["B12"],
    description:
      "A field the intent does not have is refused rather than ignored, so a field added on one side cannot be silently dropped on the other.",
    action: { type: "filter/set", filter: "src", reveal: true },
    expected: { accepted: false },
  },
  {
    id: "missing-field-on-a-known-action",
    findings: ["B12"],
    description: "An action missing what its intent requires is refused before planning.",
    action: { type: "selection/select", fileKey: FILE_KEY, hunkIndex: 0 },
    expected: { accepted: false },
  },
];
