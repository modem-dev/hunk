// Where does the Rust path's time actually go? Encoding, the call, or the measurement?
import { readFileSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { measureSanitizedTextWidth } from "/home/user/hunk/src/ui/lib/text.ts";

const { symbols } = dlopen("/home/user/hunk/crates/hunk-core/target/release/libhunk_core.so", {
  hunk_measure_widths: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
});

const patch = readFileSync(process.argv[2] ?? "big.patch", "utf8");
const lines = patch
  .split("\n")
  .filter((l) => l.startsWith("+") || l.startsWith("-") || l.startsWith(" "))
  .map((l) => l.slice(1));

const encoder = new TextEncoder();

function bench(name: string, iterations: number, fn: () => number) {
  fn();
  const start = performance.now();
  let sink = 0;
  for (let i = 0; i < iterations; i++) sink += fn();
  const ms = (performance.now() - start) / iterations;
  console.log(`${name.padEnd(44)} ${ms.toFixed(2).padStart(8)} ms  (sink=${sink % 7})`);
  return ms;
}

const N = 20;
console.log(`corpus: ${lines.length} lines\n`);

const tsTotal = bench("TS  measure (baseline)", N, () => {
  let t = 0;
  for (const l of lines) t += measureSanitizedTextWidth(l);
  return t;
});

const joinOnly = bench("RS  step 1: lines.join('\\n')", N, () => lines.join("\n").length);

const joined = lines.join("\n");
const encodeOnly = bench("RS  step 2: TextEncoder.encode", N, () => encoder.encode(joined).length);

const bytes = encoder.encode(joined);
const out = new Uint32Array(lines.length);
const callOnly = bench("RS  step 3: FFI call on pre-encoded bytes", N, () =>
  Number(symbols.hunk_measure_widths(ptr(bytes), bytes.byteLength, ptr(out), out.length)),
);

const readback = bench("RS  step 4: sum Uint32Array readback", N, () => {
  let t = 0;
  for (const w of out) t += w;
  return t;
});

console.log(`
breakdown of the full Rust path (${(joinOnly + encodeOnly + callOnly + readback).toFixed(2)} ms):
  join        ${joinOnly.toFixed(2)} ms  ${((joinOnly / (joinOnly + encodeOnly + callOnly + readback)) * 100).toFixed(0)}%
  encode      ${encodeOnly.toFixed(2)} ms  ${((encodeOnly / (joinOnly + encodeOnly + callOnly + readback)) * 100).toFixed(0)}%
  native work ${callOnly.toFixed(2)} ms  ${((callOnly / (joinOnly + encodeOnly + callOnly + readback)) * 100).toFixed(0)}%
  readback    ${readback.toFixed(2)} ms  ${((readback / (joinOnly + encodeOnly + callOnly + readback)) * 100).toFixed(0)}%

TS baseline               ${tsTotal.toFixed(2)} ms
native work alone         ${callOnly.toFixed(2)} ms   -> ${(tsTotal / callOnly).toFixed(1)}x if text were already in a native buffer
full path incl. boundary  ${(joinOnly + encodeOnly + callOnly + readback).toFixed(2)} ms   -> ${(
  tsTotal /
  (joinOnly + encodeOnly + callOnly + readback)
).toFixed(2)}x as actually callable from Bun`);
