// Profile large split-mode review streams by timing the main pure planning stages
// before the React tree and renderer get involved.
import { performance } from "perf_hooks";
import { buildSplitRows } from "../src/ui/diff/pierre";
import { buildReviewRenderPlan } from "../src/ui/diff/reviewRenderPlan";
import { measureDiffSectionMetrics } from "../src/ui/lib/sectionHeights";
import { resolveTheme } from "../src/ui/themes";
import {
  createLargeSplitStreamFiles,
  DEFAULT_FILE_COUNT,
  DEFAULT_LINES_PER_FILE,
  DEFAULT_NOTES_PER_FILE,
} from "./large-stream-fixture";

const theme = resolveTheme("midnight", null);
const windowedFiles = createLargeSplitStreamFiles({ notesPerFile: 0 });
const noteFiles = createLargeSplitStreamFiles({ notesPerFile: DEFAULT_NOTES_PER_FILE });

function visibleAgentNotesForFile(file: (typeof noteFiles)[number]) {
  const annotations = file.agent?.annotations ?? [];
  return annotations.map((annotation, index) => ({
    id: `annotation:${file.id}:${annotation.id ?? index}`,
    annotation,
  }));
}

function measureMs(run: () => void) {
  const start = performance.now();
  run();
  return performance.now() - start;
}

const sectionMetricsMs = measureMs(() => {
  windowedFiles.forEach((file) => {
    measureDiffSectionMetrics(file, "split", true, theme);
  });
});

let windowedRows = 0;
const splitRowsMs = measureMs(() => {
  windowedFiles.forEach((file) => {
    windowedRows += buildSplitRows(file, null, theme).length;
  });
});

let notePlannedRows = 0;
const noteReviewPlanMs = measureMs(() => {
  noteFiles.forEach((file) => {
    const rows = buildSplitRows(file, null, theme);
    notePlannedRows += buildReviewRenderPlan({
      fileId: file.id,
      rows,
      showHunkHeaders: true,
      visibleAgentNotes: visibleAgentNotesForFile(file),
    }).length;
  });
});

console.log(`METRIC section_metrics_ms=${sectionMetricsMs.toFixed(2)}`);
console.log(`METRIC split_rows_ms=${splitRowsMs.toFixed(2)}`);
console.log(`METRIC note_review_plan_ms=${noteReviewPlanMs.toFixed(2)}`);
console.log(`METRIC split_rows=${windowedRows}`);
console.log(`METRIC note_planned_rows=${notePlannedRows}`);
console.log(`METRIC files=${DEFAULT_FILE_COUNT}`);
console.log(`METRIC lines_per_file=${DEFAULT_LINES_PER_FILE}`);
console.log(`METRIC notes_per_file=${DEFAULT_NOTES_PER_FILE}`);
