// Parity: does the Rust width path agree with the tuned TS path on every input hunk can render?
import { readFileSync } from "node:fs";
import { measureSanitizedTextWidth } from "/home/user/hunk/src/ui/lib/text.ts";
import { sanitizeTerminalLine } from "/home/user/hunk/src/lib/terminalText.ts";
import { measureWidth, measureWidths } from "/home/user/hunk/crates/hunk-core/index.ts";

const patch = readFileSync(process.argv[2] ?? "big.patch", "utf8");
const realLines = patch
  .split("\n")
  .filter((l) => l.startsWith("+") || l.startsWith("-") || l.startsWith(" "))
  .map((l) => l.slice(1));

// Adversarial cases chosen to hit every branch the TS fast paths take.
const adversarial = [
  "",
  " ",
  "plain ascii source line",
  "\t\tindented",
  // CJK / fullwidth / halfwidth
  "名前",
  "日本語のテキスト",
  "한글 텍스트",
  "中文字符",
  "ｱｲｳｴｵ",
  "ＡＢＣ",
  "￥￡",
  // Emoji: single scalar, presentation selector, ZWJ, flags, keycap, skin tone
  "✅",
  "🎉",
  "❤️",
  "👨‍👩‍👧‍👦",
  "🇺🇸",
  "🇯🇵🇰🇷",
  "1️⃣",
  "👍🏽",
  "👩🏻‍💻",
  // Combining marks and normalization
  "é",
  "café",
  "café",
  "à́̂",
  "ñ",
  "ñ",
  // Hangul jamo composition
  "각",
  "ᄀ",
  "ꥠ",
  "ힰ",
  // Thai / Lao sara-am
  "ำ",
  "ຳ",
  "กำ",
  "ลาวຳ",
  // Halfwidth voiced marks
  "ｶﾞ",
  "ﾞ",
  "ﾟ",
  // Zero width and default-ignorable
  "a​b",
  "a‍b",
  "a﻿b",
  "­",
  "a͏b",
  // Arabic prepend + RTL
  "؀١",
  "مرحبا",
  "۝٢",
  // Box drawing runs (the repeated-glyph fast path)
  "─".repeat(40),
  "━".repeat(3),
  "│",
  "█".repeat(10),
  // Ambiguous width
  "±",
  "°",
  "→",
  "★",
  "…",
  "™",
  // Mixed
  "const 名前 = '🎉'; // ✅ done",
  "let x = 1; // ← arrow",
  // Long / pathological
  "x".repeat(500),
  "名".repeat(200),
  "🎉".repeat(100),
];

const corpus = [...adversarial, ...realLines].map(sanitizeTerminalLine);

let mismatches = 0;
const examples: string[] = [];

for (const line of corpus) {
  const ts = measureSanitizedTextWidth(line);
  const rs = measureWidth(line);
  if (ts !== rs) {
    mismatches++;
    if (examples.length < 12) {
      const codes = [...line]
        .slice(0, 8)
        .map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
      examples.push(
        `  ts=${ts} rs=${rs}  ${JSON.stringify(line.slice(0, 40))}  [${codes.join(" ")}]`,
      );
    }
  }
}

// The batch entry point must agree with the single-string one on the same corpus.
const batchable = corpus.filter((l) => !l.includes("\n"));
const batch = measureWidths(batchable);
let batchMismatches = 0;
for (let i = 0; i < batchable.length; i++) {
  if (batch[i] !== measureSanitizedTextWidth(batchable[i]!)) batchMismatches++;
}

console.log(`corpus:            ${corpus.length} lines (${adversarial.length} adversarial)`);
console.log(
  `single mismatches: ${mismatches} (${((mismatches / corpus.length) * 100).toFixed(3)}%)`,
);
console.log(`batch mismatches:  ${batchMismatches}`);
if (examples.length) {
  console.log("\nmismatch examples:");
  console.log(examples.join("\n"));
}
