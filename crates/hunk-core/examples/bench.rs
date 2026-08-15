//! Times the native paths with no FFI boundary, to separate compute cost from marshalling.
//!
//! Run with: `cargo run --release --example bench -- <patch-file>`

use std::time::Instant;

use hunk_core::{intraline::intraline_spans, width::measure_sanitized_text_width};

/// Times one closure over several iterations and reports per-pass milliseconds.
fn bench<T>(name: &str, iterations: u32, mut f: impl FnMut() -> T) -> f64 {
    f();
    let start = Instant::now();
    for _ in 0..iterations {
        std::hint::black_box(f());
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0 / f64::from(iterations);
    println!("{name:<40} {ms:>8.2} ms");
    ms
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: bench <patch-file>");
    let patch = std::fs::read_to_string(path).expect("readable patch");

    let lines: Vec<&str> = patch
        .lines()
        .filter(|l| l.starts_with('+') || l.starts_with('-') || l.starts_with(' '))
        .map(|l| &l[1..])
        .collect();

    let raw: Vec<&str> = patch.lines().collect();
    let mut pairs: Vec<(&str, &str)> = Vec::new();
    for window in raw.windows(2) {
        if window[0].starts_with('-') && window[1].starts_with('+') {
            pairs.push((&window[0][1..], &window[1][1..]));
        }
    }

    println!("corpus: {} lines, {} changed pairs\n", lines.len(), pairs.len());

    let width_ms = bench("native: measure_sanitized_text_width", 50, || {
        lines.iter().map(|l| measure_sanitized_text_width(l)).sum::<usize>()
    });
    println!("  ns/line {:.0}\n", width_ms * 1e6 / lines.len() as f64);

    let intraline_ms = bench("native: intraline_spans (histogram)", 20, || {
        pairs
            .iter()
            .map(|(before, after)| {
                let spans = intraline_spans(before, after, 10_000);
                spans.before.len() + spans.after.len()
            })
            .sum::<usize>()
    });
    println!("  ns/pair {:.0}", intraline_ms * 1e6 / pairs.len().max(1) as f64);
}
