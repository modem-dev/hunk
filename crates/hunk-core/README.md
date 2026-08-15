# hunk-core (spike)

A native implementation of two of hunk's hot paths — terminal width measurement and word-level
intraline diff — built to answer one question: **does moving hunk's hot paths to Rust pay for
itself?**

This is a measurement spike, not a shipped dependency. Nothing in `src/` imports it.

## Result

**The computation gets 8x faster. The FFI boundary gives most of that back.**

Measured on a real 66k-line hunk changeset (`git diff HEAD~40 HEAD`), 63,636 diff lines:

| Path                                         | ns/line | vs TS    |
| -------------------------------------------- | ------- | -------- |
| TS `measureSanitizedTextWidth` (baseline)    | 272     | 1.00x    |
| Rust, pure native (no boundary)              | 34      | **8.0x** |
| Rust via `bun:ffi`, whole changeset per call | 156     | 1.74x    |
| Rust via `bun:ffi`, one call per line        | 216     | 1.26x    |

Where the batched path's 10.2 ms actually goes:

| Stage                  | ms   | share |
| ---------------------- | ---- | ----- |
| `lines.join('\n')`     | 3.46 | 34%   |
| `TextEncoder.encode`   | 1.35 | 13%   |
| native measurement     | 4.42 | 43%   |
| `Uint32Array` readback | 1.00 | 10%   |

Marshalling is 57% of the cost. Handing UTF-16 JS strings to a UTF-8 native library costs more
than the work the library does, and hunk holds its diff text as JS strings.

Word-level intraline diff over the changeset's 1,761 changed line pairs: 3.34 µs/pair native,
4.53 µs/pair through FFI.

## What this implies

Width measurement is the _least_ favourable case for a native core: the TS it replaces is
already three hand-tuned fast paths deep, and its dominant path is a regex test plus
`String#length`. A 1.7x batched win does not justify a build-toolchain dependency, a second
language, and per-platform prebuilt binaries.

The finding generalises past this one function. A native core only pays when the data does not
cross the boundary per operation — which means the native side has to _own_ the text rather than
borrow it. That is an argument for Rust owning the review core (parsing git output, holding the
changeset, computing diff and highlighting, handing back only rendered rows) and an argument
against dropping a native library under individual TypeScript helpers.

Two paths remain worth measuring before concluding, both of which do far more work per byte
crossed than width measurement does:

- **Syntax highlighting.** Pierre runs Shiki (TextMate grammars over oniguruma). tree-sitter in
  Rust changes the fidelity contract, so it needs its own spike.
- **Startup.** Not addressable by a native module at all — it is Bun's cold start plus a
  130k-line module graph, and only a full port moves it.

## Parity

The Rust width path is verified against the TypeScript it would replace:

| Corpus                                    | Mismatches |
| ----------------------------------------- | ---------- |
| 63,636 real diff lines                    | **0**      |
| 60 hand-written adversarial unicode cases | **0**      |
| 200,000 randomly generated strings        | 1.79%      |

The hand-written corpus covers CJK, fullwidth and halfwidth forms, ZWJ emoji families, flags,
keycaps, skin-tone modifiers, combining marks, Hangul jamo composition, Thai and Lao sara am,
Arabic prepends, zero-width and default-ignorable characters, and repeated box-drawing runs.

Reaching parity required porting `string-width`'s rules exactly rather than approximating them.
Four differences were real bugs found by the adversarial corpus, each fixed and covered by a
regression test: summing every scalar in a cluster instead of measuring from its first visible
one, treating regional indicators as emoji bases (a lone indicator is one cell, only a pair is a
flag), dropping trailing halfwidth voiced marks, and splitting Thai sara am that ICU tailors onto
its base.

The residual 1.79% is a single known cause: `Extended_Pictographic` is approximated by block
ranges instead of generated from the UCD, so **unassigned** code points inside the emoji blocks
paired with a variation selector measure wide when `string-width` measures them narrow. Such
input cannot occur in source text, which is why the real corpus is clean. Promoting this crate
past a spike means generating the real property tables from the UCD.

One caveat is structural rather than fixable: JS strings are UTF-16 and can carry lone
surrogates; UTF-8 cannot. Text with lone surrogates must stay in TypeScript.

## Layout

- `src/width.rs` — port of `src/ui/lib/text.ts`, preserving its fast-path structure
- `src/intraline.rs` — word-level spans via imara-diff's histogram algorithm
- `src/lib.rs` — C ABI for `bun:ffi`; no state, no allocations owned across the boundary
- `index.ts` — the Bun binding
- `examples/bench.rs` — native timings with no boundary
- `bench/` — parity, fuzz, and comparison harnesses

## Running it

```sh
cargo test --release                                  # 17 unit tests
cargo build --release                                 # cdylib the binding loads
cargo run --release --example bench -- <patch-file>   # native timings

git diff HEAD~40 HEAD > /tmp/big.patch
bun run bench/parity.ts /tmp/big.patch                # TS/Rust agreement
bun run bench/fuzz.ts                                 # randomized agreement
bun run bench/bench-compare.ts /tmp/big.patch         # head-to-head
bun run bench/bench-breakdown.ts /tmp/big.patch       # where the time goes
```

The `bench/*.ts` harnesses import from absolute paths under `/home/user/hunk`; adjust them if the
repo lives elsewhere. They are outside the `tsconfig.json` include list and are not typechecked
with the rest of the project.
