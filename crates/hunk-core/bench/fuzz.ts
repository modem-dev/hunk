// Fuzz parity: random code points from the planes hunk actually renders.
import { measureSanitizedTextWidth } from "/home/user/hunk/src/ui/lib/text.ts";
import { sanitizeTerminalLine } from "/home/user/hunk/src/lib/terminalText.ts";
import { measureWidth } from "/home/user/hunk/crates/hunk-core/index.ts";

// Ranges weighted toward the classes that break naive width implementations.
const ranges: Array<[number, number]> = [
  [0x20, 0x7e], // ascii
  [0x00a0, 0x02ff], // latin supplement
  [0x0300, 0x036f], // combining diacriticals
  [0x0590, 0x06ff], // hebrew / arabic (incl. prepends)
  [0x0e00, 0x0eff], // thai / lao (sara am tailoring)
  [0x1100, 0x11ff], // hangul jamo
  [0x2000, 0x206f], // punctuation / zero-width
  [0x2190, 0x27bf], // arrows, symbols, dingbats
  [0x3000, 0x30ff], // cjk punctuation / kana
  [0x4e00, 0x9fff], // cjk ideographs
  [0xa960, 0xa97f], // jamo extended-a
  [0xac00, 0xd7a3], // hangul syllables
  [0xd7b0, 0xd7ff], // jamo extended-b
  [0xfe00, 0xfe0f], // variation selectors
  [0xff00, 0xffef], // halfwidth / fullwidth forms
  [0x1f1e6, 0x1f1ff], // regional indicators
  [0x1f300, 0x1f9ff], // emoji
  [0x1f3fb, 0x1f3ff], // skin tone modifiers
];

let seed = 0x9e3779b9;
/** Deterministic xorshift so a failing run reproduces exactly. */
function rand() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x1_0000_0000;
}

function randomChar() {
  const [lo, hi] = ranges[Math.floor(rand() * ranges.length)]!;
  const cp = lo + Math.floor(rand() * (hi - lo + 1));
  // ZWJ and VS16 deliberately over-sampled: they build the sequences that matter.
  if (rand() < 0.05) return "‍";
  if (rand() < 0.05) return "️";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "?";
  }
}

const ITERATIONS = 200_000;
let mismatches = 0;
const examples: string[] = [];

for (let i = 0; i < ITERATIONS; i++) {
  const length = 1 + Math.floor(rand() * 12);
  let raw = "";
  for (let j = 0; j < length; j++) raw += randomChar();

  const line = sanitizeTerminalLine(raw);
  // Lone surrogates cannot cross a UTF-8 boundary; the TS path owns that case by design.
  if (/[\ud800-\udfff]/.test(line.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))) continue;

  const ts = measureSanitizedTextWidth(line);
  const rs = measureWidth(line);
  if (ts !== rs) {
    mismatches++;
    if (examples.length < 10) {
      const codes = [...line].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase()}`);
      examples.push(`  ts=${ts} rs=${rs}  [${codes.join(" ")}]`);
    }
  }
}

console.log(`fuzz iterations:  ${ITERATIONS}`);
console.log(`mismatches:       ${mismatches} (${((mismatches / ITERATIONS) * 100).toFixed(4)}%)`);
if (examples.length) console.log("\nexamples:\n" + examples.join("\n"));
