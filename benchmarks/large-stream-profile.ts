// Profile large split-mode review streams by timing the main pure planning stages
// before the React tree and renderer get involved.
import { performance } from "perf_hooks";
import { buildSplitRows } from "../src/ui/diff/pierre";
import { buildReviewRenderPlan } from "../src/ui/diff/reviewRenderPlan";
import { measureDiffSectionGeometry } from "../src/ui/diff/diffSectionGeometry";
import { resolveTheme } from "../src/ui/themes";
import {
  createLargeSplitStreamFiles,
  DEFAULT_FILE_COUNT,
  DEFAULT_LINES_PER_FILE,
} from "./large-stream-fixture";

const theme = resolveTheme("midnight", null);
const windowedFiles = createLargeSplitStreamFiles();

function measureMs(run: () => void) {
  const start = performance.now();
  run();
  return performance.now() - start;
}

const sectionGeometryMs = measureMs(() => {
  windowedFiles.forEach((file) => {
    measureDiffSectionGeometry(file, "split", true, theme);
  });
});

let windowedRows = 0;
const splitRowsMs = measureMs(() => {
  windowedFiles.forEach((file) => {
    windowedRows += buildSplitRows(file, null, theme).length;
  });
});

let plannedRows = 0;
const reviewPlanMs = measureMs(() => {
  windowedFiles.forEach((file) => {
    const rows = buildSplitRows(file, null, theme);
    plannedRows += buildReviewRenderPlan({
      fileId: file.id,
      rows,
      showHunkHeaders: true,
      visibleAgentNotes: [],
    }).length;
  });
});

console.log(`METRIC section_geometry_ms=${sectionGeometryMs.toFixed(2)}`);
console.log(`METRIC split_rows_ms=${splitRowsMs.toFixed(2)}`);
console.log(`METRIC review_plan_ms=${reviewPlanMs.toFixed(2)}`);
console.log(`METRIC split_rows=${windowedRows}`);
console.log(`METRIC planned_rows=${plannedRows}`);
console.log(`METRIC files=${DEFAULT_FILE_COUNT}`);
console.log(`METRIC lines_per_file=${DEFAULT_LINES_PER_FILE}`);
