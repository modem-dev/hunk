/**
 * What the rich previews read from the page: the shown generation's resource catalog, a way to
 * read one resource, and the per-file Markdown view choice.
 *
 * Provided once by the page (`../app/ReviewApp.tsx`) and read by the stream's preview slots,
 * so the stream itself stays unaware of previews beyond rendering the slot it is given.
 */
import { createContext } from "react";
import type { ReviewResourceDescriptorV1 } from "../../core/review/resources";
import type { ReviewSide } from "../../core/review/types";

export interface PreviewContextValue {
  /** The shown generation's resources for one file. */
  resources(fileKey: string): readonly ReviewResourceDescriptorV1[];
  /** Read one resource whole, verified as the transport verifies every read. */
  read(descriptor: ReviewResourceDescriptorV1, signal: AbortSignal): Promise<Uint8Array>;
  markdownModes: MarkdownModeStore;
}

export const PreviewContext = createContext<PreviewContextValue | undefined>(undefined);

/** The side a Markdown file is rendered from: its new text, or its old text once deleted. */
export function markdownPreviewSide(changeKind: string): ReviewSide {
  return changeKind === "deleted" ? "old" : "new";
}

/** Whether a path names a Markdown document. */
export function isMarkdownPath(path: string) {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}

/** Which files show their rendered Markdown instead of the diff; per tab, not stored. */
export class MarkdownModeStore {
  private readonly rendered = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  isRendered(fileKey: string) {
    return this.rendered.has(fileKey);
  }

  toggle(fileKey: string) {
    if (this.rendered.has(fileKey)) this.rendered.delete(fileKey);
    else this.rendered.add(fileKey);
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** Show one file's diff again, if it is shown rendered (navigation into it needs its hunks). */
  showDiff(fileKey: string) {
    if (this.rendered.has(fileKey)) this.toggle(fileKey);
  }
}
