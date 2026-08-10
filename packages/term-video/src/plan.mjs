// Pure storyboard planner: expands a SHOTS table into the exact frame states
// and per-frame durations the compositor renders. Kept free of I/O and
// Playwright so the timing semantics are unit-testable.
//
// Shot shape (one entry per storyboard beat):
//   { kind: "card", html, dur, enter? }
//   { kind: "term", img, title, dur, caption?, capKey?, enter? }
//
// Semantics:
// - `capKey` is caption identity: a caption slides in only when the key
//   changes, and continuation shots that share a capKey without restating
//   `caption` keep the previous caption on screen.
// - `enter: true` animates the whole surface in (cards, first terminal shot).
// - Animated portions emit one state per frame at `fps`; holds emit a single
//   state carrying the remaining duration, so unique-frame count stays small.

/**
 * Expand shots into renderable frame states.
 *
 * @param {Array<object>} shots storyboard entries in play order
 * @param {{fps?: number, captionAnimSeconds?: number}} [options]
 * @returns {{frames: Array<{state: object, duration: number}>, totalSeconds: number}}
 */
export function planFrames(shots, options = {}) {
  const fps = options.fps ?? 30;
  const captionAnimSeconds = options.captionAnimSeconds ?? 0.45;

  const frames = [];
  let previousCapKey = null;
  let previousCaption = null;

  for (const shot of shots) {
    const caption =
      shot.caption ?? (shot.capKey && shot.capKey === previousCapKey ? previousCaption : null);
    const base =
      shot.kind === "card"
        ? { kind: "card", html: shot.html }
        : { kind: "term", img: shot.img, title: shot.title, caption };
    const captionChanges = shot.kind === "term" && shot.caption && shot.capKey !== previousCapKey;
    const animSeconds =
      shot.enter || captionChanges ? Math.min(captionAnimSeconds, shot.dur * 0.6) : 0;
    const animFrames = Math.round(animSeconds * fps);

    for (let k = 0; k < animFrames; k += 1) {
      const t = (k + 1) / animFrames;
      frames.push({
        state: { ...base, shotT: shot.enter ? t : 1, capT: captionChanges ? t : 1 },
        duration: 1 / fps,
      });
    }
    frames.push({
      state: { ...base, shotT: 1, capT: 1 },
      duration: Math.max(shot.dur - animFrames / fps, 1 / fps),
    });

    if (shot.kind === "term" && shot.caption) {
      previousCapKey = shot.capKey;
      previousCaption = shot.caption;
    } else if (shot.kind === "card") {
      previousCapKey = null;
      previousCaption = null;
    }
  }

  const totalSeconds = frames.reduce((sum, frame) => sum + frame.duration, 0);
  return { frames, totalSeconds };
}

/** Names of the terminal keyframes a storyboard needs on disk. */
export function requiredKeyframes(shots) {
  return [...new Set(shots.filter((shot) => shot.kind === "term").map((shot) => shot.img))];
}
