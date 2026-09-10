// Benchmark raw patch parsing and sanitized DiffFile construction for several diff shapes.
import { performance } from "perf_hooks";
import { parsePatchFiles } from "@pierre/diffs";
import { buildDiffFile } from "../packages/hunk/src/core/changeset/diffFile";
import { findPatchChunk, splitPatchIntoFileChunks } from "../packages/hunk/src/core/patch/chunks";
import { sanitizePatchText } from "../packages/hunk/src/core/patch/sanitize";
import { CHANGESET_PARSE_SCENARIOS, createSyntheticPatch } from "./lib/fixtures";

interface Scenario {
  name: string;
  patch: string;
}

const scenarios: Scenario[] = CHANGESET_PARSE_SCENARIOS.map(({ name, options }) => ({
  name,
  patch: createSyntheticPatch(options),
}));

function measureScenario({ name, patch }: Scenario) {
  const normalizeStart = performance.now();
  const sanitized = sanitizePatchText(patch);
  const normalizeMs = performance.now() - normalizeStart;

  const parseStart = performance.now();
  const parsed = parsePatchFiles(sanitized, "patch", true);
  const parseMs = performance.now() - parseStart;

  const splitStart = performance.now();
  const chunks = splitPatchIntoFileChunks(sanitized);
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
  console.log(`METRIC ${name}_patch_bytes=${Buffer.byteLength(sanitized)}`);
}

for (const scenario of scenarios) {
  measureScenario(scenario);
}
