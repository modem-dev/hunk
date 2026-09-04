import type {
  HistoryCommit,
  HistoryGraphCell,
  HistoryLaneCheckpoint,
  PlannedHistoryPage,
} from "./types";

/** Create the empty graph state used before the first history page. */
export function createHistoryLaneCheckpoint(): HistoryLaneCheckpoint {
  return { lanes: [] };
}

/** Return unique graph parent ids in the provider's declared order. */
function orderedUniqueParents(commit: HistoryCommit) {
  const seen = new Set<string>();
  return (commit.graphParentRevisionIds ?? commit.parentRevisionIds).filter((parent) => {
    if (seen.has(parent)) return false;
    seen.add(parent);
    return true;
  });
}

/** Plan one newest-first page while preserving enough lane state for continuation. */
export function planHistoryPage(
  commits: readonly HistoryCommit[],
  checkpoint: HistoryLaneCheckpoint = createHistoryLaneCheckpoint(),
): PlannedHistoryPage {
  const lanes = [...checkpoint.lanes];
  const pageRevisionIds = new Set<string>();
  const rows: PlannedHistoryPage["rows"] = [];

  for (const commit of commits) {
    if (pageRevisionIds.has(commit.revisionId)) {
      throw new Error(`History contains duplicate revision ${commit.revisionId}.`);
    }
    pageRevisionIds.add(commit.revisionId);

    let lane = lanes.indexOf(commit.revisionId);
    if (lane < 0) {
      // Independent tips (for example `--all`) enter at the left edge. Missing shallow parents
      // may also produce a new tip; neither case invents ancestry.
      lane = 0;
      lanes.unshift(commit.revisionId);
    }

    const lanesBefore = [...lanes];
    const parents = orderedUniqueParents(commit);
    const existingParents = parents.filter((parent) => {
      const index = lanesBefore.indexOf(parent);
      return index >= 0 && index !== lane;
    });
    lanes.splice(lane, 1, ...parents);

    // A merge parent can already be active through another child. Keep its leftmost lane and
    // collapse duplicates so topology state stays bounded by the active frontier.
    const deduplicated: string[] = [];
    for (const revisionId of lanes) {
      if (!deduplicated.includes(revisionId)) deduplicated.push(revisionId);
    }
    lanes.splice(0, lanes.length, ...deduplicated);

    const convergences = lanesBefore.flatMap((revisionId, from) => {
      if (from === lane) return [];
      const to = lanes.indexOf(revisionId);
      return to >= 0 && to !== from ? [{ from, to }] : [];
    });
    for (const parent of existingParents) {
      const to = lanes.indexOf(parent);
      if (
        to >= 0 &&
        lane !== to &&
        !convergences.some((edge) => edge.from === lane && edge.to === to)
      ) {
        convergences.push({ from: lane, to });
      }
    }
    const width = Math.max(lanesBefore.length, lanes.length, lane + 1);
    const cells: HistoryGraphCell[] = Array.from({ length: width }, (_, index) => ({
      kind: index === lane ? "node" : index < lanesBefore.length ? "vertical" : "empty",
    }));

    rows.push({
      commit,
      lane,
      cells,
      lanesBefore,
      lanesAfter: [...lanes],
      parentLanes: parents.flatMap((parent) => {
        const index = lanes.indexOf(parent);
        return index < 0 ? [] : [index];
      }),
      convergences,
    });
  }

  return {
    rows,
    checkpoint: { lanes: [...lanes] },
  };
}
