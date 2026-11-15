/**
 * Remembers the viewed mark each file is heading to, between the reader's gesture and the
 * shared state that echoes it.
 *
 * `V` pressed twice quickly, a double-click on a "Viewed" box, or key auto-repeat all read the
 * last echoed state, which has not caught up yet, so every press would send the same value.
 * A toggle instead starts from the pending value when there is one, so a second press inverts
 * the first. An entry ends when its send fails, or once the shared state at or past the
 * revision the session applied it at has been seen, whatever that state shows: a mark a
 * reload dropped must not keep steering later toggles.
 */

/** The state revision one accepted mark was applied at. */
export interface AppliedViewedMark {
  generation: string;
  stateRevision: number;
}

/** Pending viewed marks by file key. */
export class PendingViewedMarks {
  private readonly pending = new Map<string, { viewed: boolean; applied?: AppliedViewedMark }>();

  /** The mark a toggle flips: the pending one, else the one the shared state shows. */
  current(fileKey: string, shownViewed: boolean) {
    return this.pending.get(fileKey)?.viewed ?? shownViewed;
  }

  /** Record that a mark is being sent. */
  begin(fileKey: string, viewed: boolean) {
    this.pending.set(fileKey, { viewed });
  }

  /** Record that the session accepted a mark; a newer pending mark for the file is kept. */
  accepted(fileKey: string, viewed: boolean, applied: AppliedViewedMark) {
    const entry = this.pending.get(fileKey);
    if (entry?.viewed === viewed) this.pending.set(fileKey, { viewed, applied });
  }

  /** Forget a mark whose send failed; a newer pending mark for the file is kept. */
  failed(fileKey: string, viewed: boolean) {
    if (this.pending.get(fileKey)?.viewed === viewed) this.pending.delete(fileKey);
  }

  /** Forget the accepted marks the shared state at `generation` and `stateRevision` echoes. */
  observe(generation: string, stateRevision: number) {
    for (const [fileKey, entry] of this.pending) {
      const { applied } = entry;
      if (!applied) continue;
      if (applied.generation !== generation || applied.stateRevision <= stateRevision) {
        this.pending.delete(fileKey);
      }
    }
  }
}
