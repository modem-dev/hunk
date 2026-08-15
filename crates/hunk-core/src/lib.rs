//! Native hot paths for hunk's review core, exposed over a C ABI for `bun:ffi`.
//!
//! This crate deliberately holds no state and owns no allocations across the boundary. Every
//! entry point reads caller memory and writes caller memory, so the TypeScript side keeps
//! ownership of every buffer and there is nothing to free from JavaScript.
//!
//! Batch entry points exist because per-call FFI overhead dominates these workloads: measuring
//! one 40-byte line natively costs less than the call that asks for it, so the useful unit of
//! work is a whole changeset, not a row.

pub mod intraline;
pub mod width;

use std::slice;

/// Borrows caller memory as a string, returning `None` for null pointers or invalid UTF-8.
///
/// # Safety
/// `ptr` must point to `len` readable bytes that stay valid for the duration of the call.
unsafe fn borrow_str<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    std::str::from_utf8(slice::from_raw_parts(ptr, len)).ok()
}

/// Measures one string in terminal cells, returning -1 for invalid input.
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn hunk_measure_width(ptr: *const u8, len: usize) -> i64 {
    match borrow_str(ptr, len) {
        Some(text) => width::measure_sanitized_text_width(text) as i64,
        None => -1,
    }
}

/// Measures every newline-separated line in one buffer, writing widths into `out`.
///
/// Returns the number of widths written, or -1 for invalid input or insufficient capacity.
/// The buffer holds exactly one more line than it has newlines, so a trailing newline reports
/// a final empty line rather than being trimmed away; callers that joined N lines get N widths.
///
/// # Safety
/// `ptr` must point to `len` readable bytes and `out` to `out_cap` writable `u32`s.
#[no_mangle]
pub unsafe extern "C" fn hunk_measure_widths(
    ptr: *const u8,
    len: usize,
    out: *mut u32,
    out_cap: usize,
) -> i64 {
    let Some(text) = borrow_str(ptr, len) else {
        return -1;
    };
    if out.is_null() {
        return -1;
    }

    let out = slice::from_raw_parts_mut(out, out_cap);
    let mut count = 0usize;
    for line in text.split('\n') {
        if count >= out_cap {
            return -1;
        }
        out[count] = width::measure_sanitized_text_width(line) as u32;
        count += 1;
    }

    count as i64
}

/// Computes word-level changed spans between two versions of one line.
///
/// Writes `u32` triples of `(side, start_byte, end_byte)` where side 0 is the before line and
/// side 1 the after line. Returns the number of triples written, or -1 for invalid input or
/// insufficient capacity.
///
/// # Safety
/// Both pointers must reference their stated lengths, and `out` must hold `out_cap` `u32`s.
#[no_mangle]
pub unsafe extern "C" fn hunk_intraline_spans(
    before_ptr: *const u8,
    before_len: usize,
    after_ptr: *const u8,
    after_len: usize,
    max_line_len: usize,
    out: *mut u32,
    out_cap: usize,
) -> i64 {
    let (Some(before), Some(after)) = (
        borrow_str(before_ptr, before_len),
        borrow_str(after_ptr, after_len),
    ) else {
        return -1;
    };
    if out.is_null() {
        return -1;
    }

    let spans = intraline::intraline_spans(before, after, max_line_len);
    let out = slice::from_raw_parts_mut(out, out_cap);
    let mut written = 0usize;

    for (side, ranges) in [(0u32, &spans.before), (1u32, &spans.after)] {
        for range in ranges {
            if (written + 1) * 3 > out_cap {
                return -1;
            }
            out[written * 3] = side;
            out[written * 3 + 1] = range.start as u32;
            out[written * 3 + 2] = range.end as u32;
            written += 1;
        }
    }

    written as i64
}

/// Computes intraline spans for many line pairs packed into two newline-separated buffers.
///
/// Both buffers must hold the same number of lines; pair `i` is line `i` of each. Writes `u32`
/// quads of `(pair_index, side, start_byte, end_byte)` with byte offsets relative to the start
/// of that pair's line. Returns the number of quads written, or -1 on invalid input.
///
/// Line splitting matches `hunk_measure_widths`: a trailing newline yields a final empty line
/// rather than being trimmed, so N joined lines produce N pairs.
///
/// # Safety
/// Both pointers must reference their stated lengths, and `out` must hold `out_cap` `u32`s.
#[no_mangle]
pub unsafe extern "C" fn hunk_intraline_spans_batch(
    before_ptr: *const u8,
    before_len: usize,
    after_ptr: *const u8,
    after_len: usize,
    max_line_len: usize,
    out: *mut u32,
    out_cap: usize,
) -> i64 {
    let (Some(before), Some(after)) = (
        borrow_str(before_ptr, before_len),
        borrow_str(after_ptr, after_len),
    ) else {
        return -1;
    };
    if out.is_null() {
        return -1;
    }

    let out = slice::from_raw_parts_mut(out, out_cap);
    let mut written = 0usize;

    for (index, (before_line, after_line)) in before.split('\n').zip(after.split('\n')).enumerate() {
        let spans = intraline::intraline_spans(before_line, after_line, max_line_len);
        for (side, ranges) in [(0u32, &spans.before), (1u32, &spans.after)] {
            for range in ranges {
                if (written + 1) * 4 > out_cap {
                    return -1;
                }
                out[written * 4] = index as u32;
                out[written * 4 + 1] = side;
                out[written * 4 + 2] = range.start as u32;
                out[written * 4 + 3] = range.end as u32;
                written += 1;
            }
        }
    }

    written as i64
}
