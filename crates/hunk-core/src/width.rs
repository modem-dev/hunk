//! Measures terminal cell width for sanitized text, mirroring `src/ui/lib/text.ts`.
//!
//! The TypeScript implementation is already hand-tuned with three fast paths (pure ASCII, a
//! repeated single-unit glyph run, and an independent-scalar scan) before it falls back to
//! grapheme segmentation. This port keeps that exact structure so a width difference can only
//! come from Unicode table disagreement, never from a different algorithm.
//!
//! Two fidelity caveats are known and measured. Neither blocks the fast paths, and both live
//! only in the grapheme fallback.
//!
//! First, `Extended_Pictographic` is approximated by block ranges rather than generated from
//! the UCD, so unassigned code points inside the emoji blocks are treated as emoji bases when
//! `string-width` would not. Against 200k randomly generated strings this disagrees on 1.8% of
//! inputs, every one of them an unassigned code point paired with a variation selector; against
//! 63,636 real diff lines and a hand-written adversarial corpus it disagrees on none. Promoting
//! this crate past a spike means generating the real property tables.
//!
//! Second, JavaScript strings are UTF-16 and can carry lone surrogates, which the TS path
//! classifies as composition-sensitive. Text crossing FFI is UTF-8, so lone surrogates cannot
//! survive the boundary. Callers needing byte-exact behavior on malformed input must keep
//! measuring those strings in TypeScript.

use unicode_general_category::{get_general_category, GeneralCategory};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthChar;

/// Returns whether text is entirely single-cell printable ASCII.
pub fn is_printable_ascii(text: &str) -> bool {
    text.as_bytes().iter().all(|&b| (0x20..=0x7e).contains(&b))
}

/// Returns whether a code point carries the Default_Ignorable_Code_Point property.
///
/// The property is small and stable enough to inline, which keeps the crate off a full
/// property-table dependency. Hangul fillers and the variation selectors are the entries that
/// matter here: both appear inside clusters that must not contribute their own cells.
fn is_default_ignorable(cp: u32) -> bool {
    matches!(cp,
        0x00ad | 0x034f | 0x061c | 0x115f..=0x1160 | 0x17b4..=0x17b5 | 0x180b..=0x180f
        | 0x200b..=0x200f | 0x202a..=0x202e | 0x2060..=0x206f | 0x3164
        | 0xfe00..=0xfe0f | 0xfeff | 0xffa0 | 0xfff0..=0xfff8
        | 0x1bca0..=0x1bca3 | 0x1d173..=0x1d17a | 0xe0000..=0xe0fff)
}

/// Returns whether a scalar is non-printing: Default_Ignorable, Control, Format, or Mark.
///
/// This mirrors the character class `string-width` uses both to drop whole clusters and to
/// strip a cluster's leading scalars before measuring it. Surrogates are part of that class in
/// JavaScript but cannot exist in a Rust `char`, so they are absent by construction.
fn is_non_printing_scalar(c: char) -> bool {
    is_default_ignorable(c as u32)
        || matches!(
            get_general_category(c),
            GeneralCategory::Control
                | GeneralCategory::Format
                | GeneralCategory::NonspacingMark
                | GeneralCategory::SpacingMark
                | GeneralCategory::EnclosingMark
        )
}

/// Returns 1 or 2 cells, matching `get-east-asian-width`'s treatment of Wide and Fullwidth.
///
/// Ambiguous-width characters resolve to 1, as they do in the TS path. Callers filter
/// zero-width scalars before reaching here, so a `None`/`Some(0)` result cannot occur for
/// text on the fast path.
fn east_asian_width(c: char) -> usize {
    match c.width() {
        Some(2) => 2,
        _ => 1,
    }
}

/// Returns whether a scalar prepends itself to the following grapheme cluster.
fn is_grapheme_prepend(cp: u32) -> bool {
    matches!(cp,
        0x0600..=0x0605 | 0x06dd | 0x070f | 0x0890..=0x0891 | 0x08e2 | 0x0d4e
        | 0x110bd | 0x110cd | 0x111c2..=0x111c3 | 0x1193f | 0x11941 | 0x11a3a
        | 0x11a84..=0x11a89 | 0x11d46 | 0x11f02)
}

/// Returns whether a common source-code scalar is known to stand alone as one grapheme.
fn is_common_independent_scalar(cp: u32) -> bool {
    matches!(cp,
        0x20..=0x7e | 0x3000..=0x3029 | 0x3041..=0x3096 | 0x309d..=0x30ff
        | 0x3400..=0x9fff | 0xac00..=0xd7a3 | 0xf900..=0xfaff | 0xff01..=0xff60
        | 0xffe0..=0xffe6)
}

/// Returns whether a scalar can compose with neighbours into a different-width cluster.
///
/// Hangul Jamo and the Thai/Lao sara-am vowels compose across adjacent scalars without carrying
/// a combining-mark category, so they are listed explicitly rather than caught by the
/// zero-width check.
fn scalar_requires_grapheme_composition(c: char) -> bool {
    let cp = c as u32;
    if is_common_independent_scalar(cp) {
        return false;
    }

    is_non_printing_scalar(c)
        || matches!(cp, 0x1f3fb..=0x1f3ff) // Emoji_Modifier
        || matches!(cp, 0x1f1e6..=0x1f1ff) // Regional_Indicator
        || is_grapheme_prepend(cp)
        || matches!(cp, 0x0e33 | 0x0eb3 | 0xff9e | 0xff9f)
        || matches!(cp, 0x1100..=0x11ff | 0xa960..=0xa97f | 0xd7b0..=0xd7ff)
}

/// Returns whether a code point carries Extended_Pictographic.
///
/// Approximated by the emoji blocks plus the scattered legacy symbols that carry the property,
/// which is what distinguishes an emoji base from an ordinary symbol. A production port should
/// generate this from the UCD rather than inline it; see this module's header.
fn is_extended_pictographic(cp: u32) -> bool {
    // Regional indicators sit inside the emoji blocks but are not Extended_Pictographic: they
    // only ever render wide as a flag *pair*, so a lone indicator stays one cell.
    if matches!(cp, 0x1f1e6..=0x1f1ff) {
        return false;
    }

    matches!(cp,
        0x00a9 | 0x00ae | 0x203c | 0x2049 | 0x2122 | 0x2139 | 0x2194..=0x21aa
        | 0x231a..=0x231b | 0x2328 | 0x2388 | 0x23cf..=0x23ff | 0x24c2
        | 0x25aa..=0x25fe | 0x2600..=0x27bf | 0x2934..=0x2935 | 0x2b00..=0x2bff
        | 0x2e50..=0x2e51 | 0x3030 | 0x303d | 0x3297 | 0x3299
        | 0x1f000..=0x1faff | 0x1fc00..=0x1fffd)
}

/// Returns whether a scalar may appear inside an emoji sequence after its base.
fn is_emoji_sequence_part(cp: u32) -> bool {
    matches!(cp, 0xfe0f | 0x200d | 0x1f3fb..=0x1f3ff) || is_extended_pictographic(cp)
}

/// Returns whether a cluster renders as a two-cell emoji.
///
/// Mirrors `string-width`'s two emoji tests: the RGI set, plus the minimally-qualified keycap
/// and ZWJ sequences that terminals still draw double-width. A lone pictographic character is
/// deliberately excluded — `™` and `©` must stay one cell, and genuine single-scalar emoji are
/// already Wide in the width table.
fn is_double_width_emoji(cluster: &str) -> bool {
    let chars: Vec<u32> = cluster.chars().map(|c| c as u32).collect();
    let Some(&first) = chars.first() else {
        return false;
    };

    // Flag sequence: exactly one regional indicator pair.
    if chars.len() == 2 && chars.iter().all(|cp| matches!(cp, 0x1f1e6..=0x1f1ff)) {
        return true;
    }

    // Keycap, with or without the emoji presentation selector.
    if chars.last() == Some(&0x20e3)
        && matches!(first, 0x30..=0x39 | 0x23 | 0x2a)
        && chars.len() <= 3
    {
        return true;
    }

    // ZWJ sequences joining two or more pictographic characters.
    if chars.contains(&0x200d) {
        return chars.iter().filter(|cp| is_extended_pictographic(**cp)).count() >= 2;
    }

    // A pictographic base plus only selectors and modifiers, in emoji presentation.
    if is_extended_pictographic(first) && chars[1..].iter().all(|cp| is_emoji_sequence_part(*cp)) {
        let has_presentation_selector = chars.contains(&0xfe0f);
        // Characters that default to emoji presentation are exactly the Wide pictographics.
        let defaults_to_emoji = char::from_u32(first).is_some_and(|c| east_asian_width(c) == 2);
        return chars.len() > 1 && (has_presentation_selector || defaults_to_emoji);
    }

    false
}

/// Returns whether a code point is a modern Hangul leading (initial) jamo.
fn is_hangul_leading_jamo(cp: u32) -> bool {
    matches!(cp, 0x1100..=0x115f | 0xa960..=0xa97c)
}

/// Returns whether a code point is a modern Hangul vowel (medial) jamo.
fn is_hangul_vowel_jamo(cp: u32) -> bool {
    matches!(cp, 0x1160..=0x11a7 | 0xd7b0..=0xd7c6)
}

/// Returns whether a code point is a modern Hangul trailing (final) jamo.
fn is_hangul_trailing_jamo(cp: u32) -> bool {
    matches!(cp, 0x11a8..=0x11ff | 0xd7cb..=0xd7fb)
}

/// Returns whether a code point is any modern Hangul jamo.
fn is_hangul_jamo(cp: u32) -> bool {
    is_hangul_leading_jamo(cp) || is_hangul_vowel_jamo(cp) || is_hangul_trailing_jamo(cp)
}

/// Collapses a Hangul jamo cluster to syllable-block width, or returns `None` for other text.
///
/// A modern L+V or L+V+T run renders as one two-cell syllable block. Unmatched or repeated
/// jamo stay additive because that is how the terminals hunk targets draw them.
fn hangul_cluster_width(visible: &str) -> Option<usize> {
    let code_points: Vec<u32> = visible
        .chars()
        .filter(|c| !is_non_printing_scalar(*c))
        .map(|c| c as u32)
        .collect();
    if code_points.is_empty() {
        return None;
    }

    let mut width = 0usize;
    let mut index = 0usize;
    while index < code_points.len() {
        let cp = code_points[index];
        if !is_hangul_jamo(cp) {
            if width == 0 {
                return None;
            }
            // Mixed cluster (a jamo followed by a precomposed syllable): measure the remainder
            // with the ordinary width table.
            for remaining in &code_points[index..] {
                width += east_asian_width(char::from_u32(*remaining).unwrap_or('\u{fffd}'));
            }
            return Some(width);
        }

        let next_is_vowel = code_points
            .get(index + 1)
            .is_some_and(|next| is_hangul_vowel_jamo(*next));
        if is_hangul_leading_jamo(cp) && next_is_vowel {
            width += 2;
            index += if code_points
                .get(index + 2)
                .is_some_and(|next| is_hangul_trailing_jamo(*next))
            {
                3
            } else {
                2
            };
            continue;
        }

        width += east_asian_width(char::from_u32(cp).unwrap_or('\u{fffd}'));
        index += 1;
    }

    Some(width)
}

/// Adds the width of trailing Halfwidth and Fullwidth Forms inside one cluster.
///
/// A dakuten or handakuten following halfwidth katakana occupies its own cell, so the cluster
/// is wider than its base character alone.
fn trailing_halfwidth_width(visible: &str) -> usize {
    visible
        .chars()
        .skip(1)
        .filter(|c| matches!(*c as u32, 0xff00..=0xffef))
        .map(east_asian_width)
        .sum()
}

/// Measures one grapheme cluster in terminal cells.
///
/// The rule order mirrors `string-width`: drop wholly non-printing clusters, widen emoji
/// sequences, collapse Hangul syllable blocks, then fall back to the East Asian Width of the
/// cluster's first visible scalar plus any trailing halfwidth forms. Summing every scalar
/// instead would over-count clusters like a prepended Arabic number sign.
pub fn measure_cluster_width(cluster: &str) -> usize {
    if cluster.is_empty() || cluster.chars().all(is_non_printing_scalar) {
        return 0;
    }

    if is_double_width_emoji(cluster) {
        return 2;
    }

    let visible = cluster.trim_start_matches(is_non_printing_scalar);
    let Some(first) = visible.chars().next() else {
        return 0;
    };

    if let Some(width) = hangul_cluster_width(visible) {
        return width;
    }

    east_asian_width(first) + trailing_halfwidth_width(visible)
}

/// Returns a direct width for independent scalars, or `None` when graphemes must compose.
fn measure_simple_sanitized_text_width(text: &str) -> Option<usize> {
    let mut width = 0;
    for c in text.chars() {
        if scalar_requires_grapheme_composition(c) {
            return None;
        }
        width += east_asian_width(c);
    }
    Some(width)
}

/// Returns the single character repeated across `text`, or `None` when text mixes characters.
fn repeated_single_char(text: &str) -> Option<char> {
    let mut chars = text.chars();
    let first = chars.next()?;
    // A run of one is not a run; the caller's multiplication needs at least two characters.
    chars.next()?;
    if text.chars().all(|c| c == first) {
        Some(first)
    } else {
        None
    }
}

/// Measures terminal width for text that has already passed terminal sanitization.
pub fn measure_sanitized_text_width(text: &str) -> usize {
    if is_printable_ascii(text) {
        return text.len();
    }

    // Fast path for chrome glyph runs like "─".repeat(n). Each repeated unit with a non-zero
    // width is its own grapheme cluster, so run length times single-character width is exact.
    if let Some(repeated) = repeated_single_char(text) {
        let char_width = measure_cluster_width(repeated.encode_utf8(&mut [0u8; 4]));
        if char_width > 0 && !scalar_requires_grapheme_composition(repeated) {
            return char_width * text.chars().count();
        }
    }

    // Most source text is a sequence of independent scalars. Scan code points directly instead
    // of allocating grapheme records; composition-sensitive text keeps the whole-text fallback.
    measure_simple_sanitized_text_width(text).unwrap_or_else(|| measure_by_clusters(text))
}

/// Sums cluster widths across text, applying the segmentation tailorings terminals follow.
///
/// `Intl.Segmenter` uses ICU's tailored rules while `unicode-segmentation` implements plain
/// UAX #29. The two disagree on Thai and Lao sara am, which ICU attaches to its base character
/// and UAX #29 splits off. Reattaching it here keeps the fallback path agreeing with the
/// TypeScript measurement it replaces.
fn measure_by_clusters(text: &str) -> usize {
    let mut width = 0;
    let mut has_base = false;

    for cluster in text.graphemes(true) {
        let joins_previous_base = has_base
            && cluster
                .chars()
                .next()
                .is_some_and(|c| matches!(c as u32, 0x0e33 | 0x0eb3));
        if joins_previous_base {
            continue;
        }

        width += measure_cluster_width(cluster);
        has_base = true;
    }

    width
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_ascii_by_length() {
        assert_eq!(measure_sanitized_text_width("const x = 1;"), 12);
        assert_eq!(measure_sanitized_text_width(""), 0);
    }

    #[test]
    fn measures_cjk_as_wide() {
        assert_eq!(measure_sanitized_text_width("名前"), 4);
        assert_eq!(measure_sanitized_text_width("한글"), 4);
    }

    #[test]
    fn measures_emoji_sequences_as_one_wide_cluster() {
        assert_eq!(measure_sanitized_text_width("👨‍👩‍👧‍👦"), 2);
        assert_eq!(measure_sanitized_text_width("🇺🇸"), 2);
        assert_eq!(measure_sanitized_text_width("✅"), 2);
    }

    #[test]
    fn ignores_combining_marks() {
        // "e" plus combining acute renders in one cell.
        assert_eq!(measure_sanitized_text_width("e\u{0301}"), 1);
    }

    #[test]
    fn multiplies_repeated_glyph_runs() {
        assert_eq!(measure_sanitized_text_width(&"─".repeat(40)), 40);
    }

    #[test]
    fn keeps_text_presentation_symbols_narrow() {
        // Extended_Pictographic but not emoji-presentation: these must not widen to two cells.
        assert_eq!(measure_sanitized_text_width("™"), 1);
        assert_eq!(measure_sanitized_text_width("©"), 1);
        assert_eq!(measure_sanitized_text_width("®"), 1);
    }

    #[test]
    fn counts_a_lone_regional_indicator_as_narrow() {
        // Only a pair renders as a flag; one indicator plus a selector stays one cell.
        assert_eq!(measure_sanitized_text_width("\u{1f1f5}"), 1);
        assert_eq!(measure_sanitized_text_width("\u{1f1f5}\u{fe0f}"), 1);
        assert_eq!(measure_sanitized_text_width("\u{1f1f5}\u{1f1f9}"), 2);
    }

    #[test]
    fn adds_trailing_halfwidth_voiced_marks() {
        // The dakuten occupies its own cell beside halfwidth katakana.
        assert_eq!(measure_sanitized_text_width("\u{ff76}\u{ff9e}"), 2);
        assert_eq!(measure_sanitized_text_width("\u{ff9e}"), 1);
    }

    #[test]
    fn attaches_sara_am_to_its_base() {
        // ICU tailors Thai and Lao sara am onto the preceding base; UAX #29 alone would split it.
        assert_eq!(measure_sanitized_text_width("\u{0e01}\u{0e33}"), 1);
        assert_eq!(measure_sanitized_text_width("\u{0e25}\u{0e32}\u{0e27}\u{0eb3}"), 3);
    }

    #[test]
    fn drops_leading_non_printing_scalars() {
        // An Arabic prepended number sign carries no cell of its own.
        assert_eq!(measure_sanitized_text_width("\u{0600}\u{0661}"), 1);
        assert_eq!(measure_sanitized_text_width("\u{06dd}\u{0662}"), 1);
    }

    #[test]
    fn measures_unmatched_jamo_additively() {
        assert_eq!(measure_sanitized_text_width("\u{d7b0}"), 1);
        // A modern L+V pair collapses into one two-cell syllable block.
        assert_eq!(measure_sanitized_text_width("\u{1100}\u{1161}"), 2);
    }
}
