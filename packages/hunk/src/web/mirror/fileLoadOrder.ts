/**
 * Decides which file of a loading generation the mirror reads next.
 *
 * A large review cannot load every file before the reader looks at one, so a free read slot
 * takes, in turn: the target of a jump still waiting for its file (an agent's `hunk session
 * navigate`, a deep link, go-to-file, a sidebar click), then the files the stream is about to
 * draw around the viewport, then everything else in document order. The priorities are read
 * live on every pick, so a reader who jumps or scrolls while files load reorders every read
 * that has not started; reads already in flight finish. Each file is handed out at most once.
 */
import type { ReviewResourceReadOrder } from "../transport/apiClient";

/** Why the page wants some files before the rest, highest first. */
export type ClientReviewLoadPriority = "target" | "viewport";

/** The priorities in the order they are served. */
export const CLIENT_REVIEW_LOAD_PRIORITIES: readonly ClientReviewLoadPriority[] = [
  "target",
  "viewport",
];

/** One generation's read order over its canonical files. */
export class ClientFileLoadOrder implements ReviewResourceReadOrder {
  private readonly started = new Set<number>();
  private cursor = 0;

  /**
   * @param documentKeys every file key in document order, the background order
   * @param readIndexByKey each loadable file's index in the descriptors being read
   * @param wanted the keys each priority currently names, highest priority first
   */
  constructor(
    private readonly documentKeys: readonly string[],
    private readonly readIndexByKey: ReadonlyMap<string, number>,
    private readonly wanted: () => readonly (readonly string[])[],
  ) {}

  next(): number | undefined {
    for (const keys of this.wanted()) {
      for (const key of keys) {
        const index = this.take(key);
        if (index !== undefined) return index;
      }
    }
    while (this.cursor < this.documentKeys.length) {
      const index = this.take(this.documentKeys[this.cursor]!);
      this.cursor += 1;
      if (index !== undefined) return index;
    }
    return undefined;
  }

  /** Claim one file's read if it is loadable and not started yet. */
  private take(key: string) {
    const index = this.readIndexByKey.get(key);
    if (index === undefined || this.started.has(index)) return undefined;
    this.started.add(index);
    return index;
  }
}
