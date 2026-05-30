// Benchmark pure diff row/layout planning across split, stack, and size-shape cases.
import { performance } from "perf_hooks";
import { buildSplitRows, buildStackRows } from "../src/ui/diff/pierre";
import { buildReviewRenderPlan } from "../src/ui/diff/reviewRenderPlan";
import { measureDiffSectionGeometry } from "../src/ui/diff/diffSectionGeometry";
import { resolveTheme } from "../src/ui/themes";
import { createLargeSplitStreamFiles } from "./large-stream-fixture";

const theme = resolveTheme("midnight", null);

function measureMs(run: () => void) {
  const start = performance.now();
  run();
  return performance.now() - start;
}

function measureScenario(name: string, files: ReturnType<typeof createLargeSplitStreamFiles>) {
  let splitRows = 0;
  let stackRows = 0;
  let plannedRows = 0;

  const splitRowsMs = measureMs(() => {
    for (const file of files) {
      splitRows += buildSplitRows(file, null, theme).length;
    }
  });

  const stackRowsMs = measureMs(() => {
    for (const file of files) {
      stackRows += buildStackRows(file, null, theme).length;
    }
  });

  const geometryMs = measureMs(() => {
    for (const file of files) {
      measureDiffSectionGeometry(file, "split", true, theme);
    }
  });

  const reviewPlanMs = measureMs(() => {
    for (const file of files) {
      const rows = buildSplitRows(file, null, theme);
      plannedRows += buildReviewRenderPlan({
        fileId: file.id,
        rows,
        showHunkHeaders: true,
        visibleAgentNotes: [],
      }).length;
    }
  });

  console.log(`METRIC ${name}_split_rows_ms=${splitRowsMs.toFixed(2)}`);
  console.log(`METRIC ${name}_stack_rows_ms=${stackRowsMs.toFixed(2)}`);
  console.log(`METRIC ${name}_geometry_ms=${geometryMs.toFixed(2)}`);
  console.log(`METRIC ${name}_review_plan_ms=${reviewPlanMs.toFixed(2)}`);
  console.log(`METRIC ${name}_files=${files.length}`);
  console.log(`METRIC ${name}_split_rows=${splitRows}`);
  console.log(`METRIC ${name}_stack_rows=${stackRows}`);
  console.log(`METRIC ${name}_planned_rows=${plannedRows}`);
}

measureScenario(
  "many_small_files",
  createLargeSplitStreamFiles({ fileCount: 360, linesPerFile: 48 }),
);
measureScenario(
  "balanced_stream",
  createLargeSplitStreamFiles({ fileCount: 180, linesPerFile: 120 }),
);
measureScenario(
  "large_single_file",
  createLargeSplitStreamFiles({
    fileCount: 1,
    linesPerFile: 18_000,
    changedStartLine: 1_000,
    changedEndLine: 17_000,
  }),
);
