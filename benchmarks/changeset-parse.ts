// Benchmark raw patch parsing and normalized DiffFile construction for several diff shapes.
import { performance } from "perf_hooks";
import { parsePatchFiles } from "@pierre/diffs";
import { buildDiffFile } from "../src/core/diffFile";
import { findPatchChunk, splitPatchIntoFileChunks } from "../src/core/patch/chunks";
import { normalizePatchText } from "../src/core/patch/normalize";
import { createSyntheticPatch } from "./lib/fixtures";

interface Scenario {
  name: string;
  patch: string;
}

const scenarios: Scenario[] = [
  {
    name: "many_small_files",
    patch: createSyntheticPatch({ fileCount: 240, lines: 48, changedLines: 8 }),
  },
  {
    name: "balanced_changeset",
    patch: createSyntheticPatch({ fileCount: 96, lines: 220, changedLines: 48 }),
  },
  {
    name: "large_single_file",
    patch: createSyntheticPatch({ fileCount: 1, lines: 18_000, changedLines: 2_000 }),
  },
];

function measureScenario({ name, patch }: Scenario) {
  const normalizeStart = performance.now();
  const normalized = normalizePatchText(patch);
  const normalizeMs = performance.now() - normalizeStart;

  const parseStart = performance.now();
  const parsed = parsePatchFiles(normalized, "patch", true);
  const parseMs = performance.now() - parseStart;

  const splitStart = performance.now();
  const chunks = splitPatchIntoFileChunks(normalized);
  const splitMs = performance.now() - splitStart;

  const files = parsed.flatMap((entry) => entry.files);
  const buildStart = performance.now();
  const diffFiles = files.map((metadata, index) =>
    buildDiffFile(metadata, findPatchChunk(metadata, chunks, index), index, name, null),
  );
  const buildMs = performance.now() - buildStart;

  console.log(`METRIC ${name}_normalize_patch_ms=${normalizeMs.toFixed(2)}`);
  console.log(`METRIC ${name}_parse_patch_ms=${parseMs.toFixed(2)}`);
  console.log(`METRIC ${name}_split_chunks_ms=${splitMs.toFixed(2)}`);
  console.log(`METRIC ${name}_build_diff_files_ms=${buildMs.toFixed(2)}`);
  console.log(`METRIC ${name}_files=${diffFiles.length}`);
  console.log(`METRIC ${name}_patch_bytes=${Buffer.byteLength(normalized)}`);
}

for (const scenario of scenarios) {
  measureScenario(scenario);
}
