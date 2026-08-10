// Benchmark Hunk's scalar fast path and complex-cluster fallback.
import { performance } from "node:perf_hooks";
import { measureTextWidth } from "../src/ui/lib/text";

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

/** Time one deterministic terminal-text shape. */
function measureScenario(name: string, corpus: WidthCorpus) {
  measureWidthCalls(measureTextWidth, corpus, WARMUP_ITERATIONS);

  const measurement = measureWidthCalls(measureTextWidth, corpus, ITERATIONS);
  console.log(`METRIC ${name}_text_width_ms=${measurement.elapsedMs.toFixed(2)}`);
  console.log(`METRIC ${name}_width_measurements=${ITERATIONS * corpus.length}`);
  console.log(`METRIC ${name}_width_checksum=${measurement.checksum}`);
}

measureScenario("cjk_scalar", CJK_SCALAR_LINES);
measureScenario("emoji_scalar", EMOJI_SCALAR_LINES);
measureScenario("complex_cluster", COMPLEX_CLUSTER_LINES);
