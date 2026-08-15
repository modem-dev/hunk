//! Computes word-level intraline diff spans for one changed line pair.
//!
//! Hunk currently gets these spans from Pierre's `lineDiffType: "word-alt"` renderer, which
//! computes them inside the same pass that runs syntax highlighting. Splitting them out lets
//! the span computation move to the histogram algorithm while highlighting stays where it is.
//!
//! Spans are reported as byte offsets into the original lines so the caller can slice without
//! re-tokenizing. Offsets are UTF-8 byte offsets, not UTF-16 code units: a TypeScript caller
//! slicing a JS string must convert, or slice the same UTF-8 buffer it passed in.

use imara_diff::{Algorithm, Diff, InternedInput, TokenSource};
use std::ops::Range;

/// Splits a line into diffable word tokens.
///
/// Tokens are runs of alphanumerics (including `_`, so identifiers stay whole), runs of
/// whitespace, and individual punctuation characters. Keeping punctuation separate means a
/// changed argument inside `foo(a, b)` highlights the argument rather than the whole call.
struct Words<'a>(&'a str);

/// Yields `(byte_offset, token)` pairs so hunk ranges map back to slices of the source line.
struct WordIter<'a> {
    text: &'a str,
    offset: usize,
}

impl<'a> Iterator for WordIter<'a> {
    type Item = (usize, &'a str);

    fn next(&mut self) -> Option<Self::Item> {
        let rest = &self.text[self.offset..];
        let mut chars = rest.char_indices();
        let (_, first) = chars.next()?;

        let class = char_class(first);
        let start = self.offset;
        // Punctuation is always its own token, so it never extends past the first character.
        let len = if class == CharClass::Punctuation {
            first.len_utf8()
        } else {
            rest.char_indices()
                .find(|(_, c)| char_class(*c) != class)
                .map(|(i, _)| i)
                .unwrap_or(rest.len())
        };

        self.offset += len;
        Some((start, &rest[..len]))
    }
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum CharClass {
    Word,
    Whitespace,
    Punctuation,
}

/// Classifies a character into the run it may join.
fn char_class(c: char) -> CharClass {
    if c.is_alphanumeric() || c == '_' {
        CharClass::Word
    } else if c.is_whitespace() {
        CharClass::Whitespace
    } else {
        CharClass::Punctuation
    }
}

impl<'a> TokenSource for Words<'a> {
    type Token = &'a str;
    type Tokenizer = std::iter::Map<WordIter<'a>, fn((usize, &'a str)) -> &'a str>;

    fn tokenize(&self) -> Self::Tokenizer {
        fn strip<'b>(pair: (usize, &'b str)) -> &'b str {
            pair.1
        }
        WordIter {
            text: self.0,
            offset: 0,
        }
        .map(strip as fn((usize, &'a str)) -> &'a str)
    }

    fn estimate_tokens(&self) -> u32 {
        // Source lines average a token every few bytes; overshooting only costs interner capacity.
        (self.0.len() / 4).max(1) as u32
    }
}

/// Byte ranges that differ between two versions of one line.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct IntralineSpans {
    /// Ranges removed from the old line.
    pub before: Vec<Range<usize>>,
    /// Ranges added to the new line.
    pub after: Vec<Range<usize>>,
}

/// Maps token indexes back to byte offsets in the source line.
fn token_bounds(text: &str) -> Vec<usize> {
    let mut bounds: Vec<usize> = WordIter { text, offset: 0 }.map(|(start, _)| start).collect();
    bounds.push(text.len());
    bounds
}

/// Computes word-level changed spans between two versions of a line.
///
/// Returns empty spans when the lines are identical. Lines longer than `max_len` bytes return
/// a whole-line span on each side instead, matching the way Pierre's `maxLineDiffLength` gives
/// up on generated or minified content rather than paying quadratic cost for it.
pub fn intraline_spans(before: &str, after: &str, max_len: usize) -> IntralineSpans {
    if before == after {
        return IntralineSpans::default();
    }
    if before.len() > max_len || after.len() > max_len {
        return IntralineSpans {
            before: vec![0..before.len()],
            after: vec![0..after.len()],
        };
    }

    let input = InternedInput::new(Words(before), Words(after));
    let diff = Diff::compute(Algorithm::Histogram, &input);

    let before_bounds = token_bounds(before);
    let after_bounds = token_bounds(after);
    let mut spans = IntralineSpans::default();

    for hunk in diff.hunks() {
        if !hunk.before.is_empty() {
            let start = before_bounds[hunk.before.start as usize];
            let end = before_bounds[hunk.before.end as usize];
            spans.before.push(start..end);
        }
        if !hunk.after.is_empty() {
            let start = after_bounds[hunk.after.start as usize];
            let end = after_bounds[hunk.after.end as usize];
            spans.after.push(start..end);
        }
    }

    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX: usize = 10_000;

    #[test]
    fn reports_no_spans_for_identical_lines() {
        assert_eq!(intraline_spans("let x = 1;", "let x = 1;", MAX), IntralineSpans::default());
    }

    #[test]
    fn isolates_a_changed_identifier() {
        let spans = intraline_spans("let alpha = 1;", "let beta = 1;", MAX);
        assert_eq!(spans.before.len(), 1);
        assert_eq!(&"let alpha = 1;"[spans.before[0].clone()], "alpha");
        assert_eq!(&"let beta = 1;"[spans.after[0].clone()], "beta");
    }

    #[test]
    fn isolates_one_argument_inside_a_call() {
        let spans = intraline_spans("foo(a, b)", "foo(a, c)", MAX);
        assert_eq!(&"foo(a, c)"[spans.after[0].clone()], "c");
    }

    #[test]
    fn reports_pure_insertion_without_a_before_span() {
        let spans = intraline_spans("let x;", "let x = 1;", MAX);
        assert!(spans.before.is_empty());
        assert!(!spans.after.is_empty());
    }

    #[test]
    fn falls_back_to_whole_line_past_the_length_limit() {
        let long_before = "a".repeat(50);
        let long_after = "b".repeat(50);
        let spans = intraline_spans(&long_before, &long_after, 10);
        assert_eq!(spans.before, vec![0..50]);
        assert_eq!(spans.after, vec![0..50]);
    }

    #[test]
    fn keeps_multibyte_spans_on_character_boundaries() {
        let before = "const 名前 = 1;";
        let after = "const 名前 = 2;";
        let spans = intraline_spans(before, after, MAX);
        // Slicing on a non-boundary would panic, so a successful slice is the assertion.
        assert_eq!(&before[spans.before[0].clone()], "1");
        assert_eq!(&after[spans.after[0].clone()], "2");
    }
}
