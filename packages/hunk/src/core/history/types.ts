import type { ExtensionVcsHistoryCommit } from "../../extension-api/types";

/** One normalized commit in newest-first provider order. */
export type HistoryCommit = ExtensionVcsHistoryCommit;

/** JSON-safe state required to continue planning graph lanes on a later page. */
export interface HistoryLaneCheckpoint {
  lanes: string[];
}

/** One symbolic lane shown on a commit row. */
export interface HistoryGraphCell {
  kind: "vertical" | "node" | "empty";
}

/** One symbolic graph row plus the lane mapping after its commit. */
export interface HistoryGraphRow {
  commit: HistoryCommit;
  lane: number;
  cells: HistoryGraphCell[];
  lanesBefore: string[];
  lanesAfter: string[];
  parentLanes: number[];
  /** Existing active lanes that collapse into a parent lane after this commit. */
  convergences: Array<{ from: number; to: number }>;
}

/** A planned page and the checkpoint used by the following page. */
export interface PlannedHistoryPage {
  rows: HistoryGraphRow[];
  checkpoint: HistoryLaneCheckpoint;
}
