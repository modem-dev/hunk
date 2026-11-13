/**
 * Holds the page's open note composers: new notes, replies, and edits being written.
 *
 * Composers are this page's own — the session's shared draft slot is never used — so several
 * may be open at once, in different files or on different lines. Each is keyed by its anchor
 * (kind, file, side and line, and the note it replies to or edits), and opening one at an
 * anchor that already has a composer focuses that one instead.
 *
 * Unsent drafts survive a tab reload: every change is written to `sessionStorage` under the
 * session's id (tab-scoped, never the capability), and cleared once the session accepts a
 * save, or on cancel. A restored draft remembers the content identity of the file it was
 * written against; when the file the page loads has different content, the draft is kept but
 * marked `changed` and cannot be sent until the reader discards it or re-targets it, so it
 * never lands on changed lines silently.
 *
 * Saving does not return the new note's id, so a sent composer waits for the shared state:
 * it closes once a snapshot at or after the position the session applied it at arrives.
 */
import type { ReviewExpandedLineClaim } from "../../core/review/expansion";
import type { ReviewNoteTargetV1, ReviewSide } from "../../core/review/types";

/** What a composer writes. */
export type NoteComposerKind = "new" | "reply" | "edit";

/** One open composer. */
export interface NoteComposer {
  key: string;
  kind: NoteComposerKind;
  fileKey: string;
  hunkIndex: number;
  /** The line its card hangs beside. */
  side: ReviewSide;
  line: number;
  target?: ReviewNoteTargetV1;
  expandedLineProof?: ReviewExpandedLineClaim;
  /** The note a reply answers. */
  parentId?: string;
  /** The note an edit changes. */
  noteId?: string;
  /** The file content the draft was written against. */
  contentIdentity: string;
  body: string;
  status: "editing" | "sending" | "failed" | "changed";
  error?: string;
  /** The position a sent composer waits for the shared state to reach. */
  awaiting?: { generation: string; stateRevision: number };
}

/** The anchor key one composer is stored under. */
export function noteComposerKey(
  composer: Pick<NoteComposer, "kind" | "fileKey" | "side" | "line" | "parentId" | "noteId">,
) {
  return [
    composer.kind,
    composer.fileKey,
    composer.side,
    composer.line,
    composer.parentId ?? composer.noteId ?? "",
  ]
    .map((part) => encodeURIComponent(String(part)))
    .join(":");
}

/** The storage key for one session's drafts. */
export function noteDraftStorageKey(sessionId: string) {
  return `hunk.review.drafts:${sessionId}`;
}

/**
 * Return this tab's `sessionStorage`, or nothing where there is none or the browser refuses it.
 *
 * Reading `window.sessionStorage` itself throws when storage is blocked, so the lookup is
 * guarded here rather than left to a default parameter.
 */
function tabStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** The page's composers, observable by React. */
export class NoteComposerStore {
  private composers: readonly NoteComposer[] = [];
  private readonly listeners = new Set<() => void>();
  /** The last shared-state position seen, for a save whose answer arrives after it. */
  private seen: { generation: string; stateRevision: number } | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly storage:
      | Pick<Storage, "getItem" | "setItem" | "removeItem">
      | undefined = tabStorage(),
  ) {
    this.composers = this.read();
  }

  getSnapshot = () => this.composers;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Open a composer, or return the key of the one already open at that anchor. */
  open(composer: Omit<NoteComposer, "key" | "status" | "body"> & { body?: string }) {
    const key = noteComposerKey(composer);
    if (this.composers.some((existing) => existing.key === key)) return key;
    this.set([
      ...this.composers,
      { ...composer, key, body: composer.body ?? "", status: "editing" },
    ]);
    return key;
  }

  /** Replace one composer's fields. */
  update(key: string, patch: Partial<Omit<NoteComposer, "key">>) {
    if (!this.composers.some((composer) => composer.key === key)) return;
    this.set(
      this.composers.map((composer) =>
        composer.key === key ? { ...composer, ...patch } : composer,
      ),
    );
    // The shared state can show the note before the save's answer names the position it
    // waits for; settle against what was already seen rather than wait for another snapshot.
    if (patch.awaiting && this.seen) this.settleSent(this.seen);
  }

  /** Close one composer and forget its draft. */
  close(key: string) {
    if (!this.composers.some((composer) => composer.key === key)) return;
    this.set(this.composers.filter((composer) => composer.key !== key));
  }

  /**
   * Check restored drafts against the files the page now shows.
   *
   * A draft whose file is present with other content becomes `changed`. A file the page does
   * not show (still loading, or gone from this review) leaves its draft as it was.
   */
  reconcileContent(identityByFileKey: ReadonlyMap<string, string>) {
    let changed = false;
    const next = this.composers.map((composer) => {
      if (composer.status === "sending" || composer.status === "changed") return composer;
      const identity = identityByFileKey.get(composer.fileKey);
      if (identity === undefined || identity === composer.contentIdentity) return composer;
      changed = true;
      return { ...composer, status: "changed" as const };
    });
    if (changed) this.set(next);
  }

  /** Close every sent composer the shared state has caught up with. */
  settleSent(position: { generation: string; stateRevision: number }) {
    this.seen = position;
    const remaining = this.composers.filter(
      (composer) =>
        composer.status !== "sending" ||
        !composer.awaiting ||
        (composer.awaiting.generation === position.generation &&
          position.stateRevision < composer.awaiting.stateRevision),
    );
    if (remaining.length !== this.composers.length) this.set(remaining);
  }

  private set(next: readonly NoteComposer[]) {
    this.composers = next;
    this.write();
    for (const listener of Array.from(this.listeners)) listener();
  }

  /**
   * Persist every draft the session has not accepted yet.
   *
   * A composer still sending keeps its backup, so a refused or interrupted save (the tab
   * closed mid-request) has its text after a reload; once the session accepted it (`awaiting`
   * is set) the note is the session's.
   */
  private write() {
    const drafts = this.composers.filter(
      (composer) => composer.status !== "sending" || !composer.awaiting,
    );
    try {
      if (drafts.length === 0) this.storage?.removeItem(noteDraftStorageKey(this.sessionId));
      else this.storage?.setItem(noteDraftStorageKey(this.sessionId), JSON.stringify(drafts));
    } catch {
      // A blocked or full storage loses only the reload safety net.
    }
  }

  /** Read the drafts this tab left, ignoring anything malformed. */
  private read(): NoteComposer[] {
    try {
      const raw = this.storage?.getItem(noteDraftStorageKey(this.sessionId));
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((value): NoteComposer[] => {
        const draft = value as Partial<NoteComposer>;
        const valid =
          (draft.kind === "new" || draft.kind === "reply" || draft.kind === "edit") &&
          typeof draft.fileKey === "string" &&
          typeof draft.hunkIndex === "number" &&
          (draft.side === "old" || draft.side === "new") &&
          typeof draft.line === "number" &&
          typeof draft.contentIdentity === "string" &&
          typeof draft.body === "string";
        if (!valid) return [];
        const composer = draft as NoteComposer;
        return [
          {
            ...composer,
            key: noteComposerKey(composer),
            status: composer.status === "changed" ? "changed" : "editing",
          },
        ];
      });
    } catch {
      return [];
    }
  }
}
