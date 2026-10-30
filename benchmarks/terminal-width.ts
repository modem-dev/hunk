// Benchmark Hunk's scalar fast path and cached complex-cluster path against string-width.
import { performance } from "node:perf_hooks";
import stringWidth from "string-width";
import { measureTextWidth } from "../packages/hunk/src/ui/lib/text";

const ITERATIONS = 2_000;
const WARMUP_ITERATIONS = 50;
const CJK_SCALAR_LINES = [
  "export const message = 日本語のコメントです。変更内容を確認してください。",
  "export function 測定値を計算する(入力: number) { return 入力 * 2; }",
  "中文注释内容：这个变更优化了终端单元格宽度测量。",
  "请检查新增、删除和未修改的代码行是否正确对齐。",
  "한국어 주석 내용과 함수 이름을 함께 측정합니다.",
  "터미널 셀 너비를 빠르게 계산하고 정렬을 유지합니다.",
] as const;
const EMOJI_SCALAR_LINES = [
  "🚀 ✨ 🔧 💡 🎯 📦 🔍 standalone emoji scalars",
  "✅ 🚧 🐛 🎉 🧪 📊 terminal status glyphs",
] as const;
const COMPLEX_CLUSTER_LINES = [
  "🧑‍💻 👩‍🔬 👨‍👩‍👧‍👦 complex emoji clusters stay aligned",
  "e\u0301 a\u0308 o\u0302 u\u0308 combining clusters keep their reference widths",
] as const;

type WidthMeasure = (text: string) => number;
type WidthCorpus = readonly string[];

/** Measure repeated width calls and retain their total so the work stays observable. */
function measureWidthCalls(measure: WidthMeasure, corpus: WidthCorpus, iterations: number) {
  let checksum = 0;
  const start = performance.now();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const line of corpus) {
      checksum += measure(line);
    }
  }

  return { elapsedMs: performance.now() - start, checksum };
}

/** Verify and time one deterministic terminal-text shape. */
function measureScenario(name: string, corpus: WidthCorpus) {
  for (const line of corpus) {
    const actual = measureTextWidth(line);
    const reference = stringWidth(line);
    if (actual !== reference) {
      throw new Error(`Width mismatch for ${JSON.stringify(line)}: ${actual} !== ${reference}`);
    }
  }

  measureWidthCalls(stringWidth, corpus, WARMUP_ITERATIONS);
  measureWidthCalls(measureTextWidth, corpus, WARMUP_ITERATIONS);

  const reference = measureWidthCalls(stringWidth, corpus, ITERATIONS);
  const optimized = measureWidthCalls(measureTextWidth, corpus, ITERATIONS);
  if (optimized.checksum !== reference.checksum) {
    throw new Error(`Width checksum mismatch: ${optimized.checksum} !== ${reference.checksum}`);
  }

  const speedup = reference.elapsedMs / optimized.elapsedMs;
  console.log(`METRIC ${name}_text_width_ms=${optimized.elapsedMs.toFixed(2)}`);
  // External reference timings are informational and should not gate Hunk releases.
  console.log(`METRIC competitor_string_width_${name}_ms=${reference.elapsedMs.toFixed(2)}`);
  console.log(`METRIC ${name}_width_measurements=${ITERATIONS * corpus.length}`);
  console.log(`METRIC ${name}_width_checksum=${optimized.checksum}`);
  console.log(`${name} width speedup versus string-width: ${speedup.toFixed(2)}x`);
}

measureScenario("cjk_scalar", CJK_SCALAR_LINES);
measureScenario("emoji_scalar", EMOJI_SCALAR_LINES);
measureScenario("complex_cluster", COMPLEX_CLUSTER_LINES);
