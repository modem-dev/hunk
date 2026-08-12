import type { HunkReviewManifestV1, HunkReviewStateV1 } from "../../session/reviewProtocol";

/** Complete browser-facing snapshot mirrored by the loopback broker. */
export interface BrowserReviewSnapshot {
  generation: string;
  manifest: HunkReviewManifestV1;
  state: HunkReviewStateV1;
}

export type BrowserReviewDocument = HunkReviewManifestV1;
export type BrowserReviewFile = HunkReviewManifestV1["files"][number];

export type BrowserConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "expired";
