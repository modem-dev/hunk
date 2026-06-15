/** Delay used to coalesce imperative ScrollBox viewport reads to roughly one frame. */
export const VIEWPORT_READ_COALESCE_MS = 16;

/**
 * Interval between attempts to seed the initial viewport height. OpenTUI computes the
 * scrollbox viewport height during its first layout pass, which can land after this pane's
 * binding effect attaches its `layout-changed` listener — so the first event is missed and
 * the height stays 0 until the next layout recalc (only a scroll triggers one). We poll the
 * already-computed height a few early frames apart until it appears, then stop.
 */
export const VIEWPORT_HEIGHT_SEED_RETRY_MS = 16;

/** Maximum number of initial viewport-height seed attempts before giving up (bounded one-shot). */
export const VIEWPORT_HEIGHT_SEED_MAX_ATTEMPTS = 8;
