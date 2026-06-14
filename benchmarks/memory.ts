// Track heap/RSS pressure for loading, planning, rendering, and navigating a large diff.
import { performance } from "perf_hooks";
import { testRender } from "@opentui/solid";
import { createComponent } from "solid-js";
import { buildSplitRows } from "../src/ui/diff/pierre";
import { buildReviewRenderPlan } from "../src/ui/diff/reviewRenderPlan";
import { resolveTheme } from "../src/ui/themes";
import { AppHost } from "../src/ui/AppHost";
import { createLargeSplitStreamBootstrap } from "./large-stream-fixture";

const viewport = { width: 240, height: 28 } as const;

function printMemory(prefix: string) {
  const usage = process.memoryUsage();
  console.log(`METRIC ${prefix}_rss_bytes=${usage.rss}`);
  console.log(`METRIC ${prefix}_heap_used_bytes=${usage.heapUsed}`);
}

async function renderOnce(setup: Awaited<ReturnType<typeof testRender>>) {
  await setup.renderOnce();
  await Bun.sleep(0);
}

const bootstrapStart = performance.now();
const bootstrap = createLargeSplitStreamBootstrap({
  fileCount: 120,
  linesPerFile: 120,
});
console.log(`METRIC bootstrap_fixture_ms=${(performance.now() - bootstrapStart).toFixed(2)}`);
printMemory("after_bootstrap");

const theme = resolveTheme("midnight", null);
let plannedRows = 0;
const planningStart = performance.now();
for (const file of bootstrap.changeset.files) {
  const rows = buildSplitRows(file, null, theme);
  plannedRows += buildReviewRenderPlan({
    fileId: file.id,
    rows,
    showHunkHeaders: true,
    visibleAgentNotes: [],
  }).length;
}
console.log(`METRIC planning_ms=${(performance.now() - planningStart).toFixed(2)}`);
console.log(`METRIC planned_rows=${plannedRows}`);
printMemory("after_planning");

const setup = await testRender(() => createComponent(AppHost, { bootstrap }), viewport);
try {
  const firstFrameStart = performance.now();
  await renderOnce(setup);
  console.log(`METRIC first_frame_ms=${(performance.now() - firstFrameStart).toFixed(2)}`);
  printMemory("after_first_frame");

  const navigationStart = performance.now();
  for (let index = 0; index < 6; index += 1) {
    await setup.mockInput.typeText("]");
    await setup.renderOnce();
    await Bun.sleep(0);
  }
  console.log(`METRIC next_hunk_navigation_ms=${(performance.now() - navigationStart).toFixed(2)}`);
  printMemory("after_navigation");
} finally {
  setup.renderer.destroy();
}
