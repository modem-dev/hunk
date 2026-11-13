/**
 * Tracks whether the reader is still editing the shared filter field.
 *
 * Each edit takes a new sequence number and marks the field as being edited, so the shared
 * value does not overwrite what the reader is typing. Only the reply to the latest edit ends
 * the editing: a slower reply to an older request arriving after a newer edit leaves the
 * field alone, or a snapshot of the older filter would replace the newer text.
 */
export class FilterEditSequence {
  private latest = 0;
  private open = false;

  /** Whether an edit is still waiting for its reply. */
  get editing() {
    return this.open;
  }

  /** Record one edit and return its sequence number. */
  edit() {
    this.latest += 1;
    this.open = true;
    return this.latest;
  }

  /** Record the reply to the edit numbered `sequence`; only the latest one ends editing. */
  settle(sequence: number) {
    if (sequence === this.latest) this.open = false;
  }
}
