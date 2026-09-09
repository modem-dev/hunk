// Pure storyboard planner: expands a SHOTS table into the exact frame states
// and per-frame durations the compositor renders. Kept free of I/O and
// Playwright so the timing semantics are unit-testable.
//
// Shot shape (one entry per storyboard beat):
//   { kind: "card", html, dur, enter? }
//   { kind: "term", img, title, dur, caption?, capKey?, enter?, camera?, cameraKey?, highlight?, motion? }
//
// Semantics:
// - `capKey` is caption identity: a caption slides in only when the key
//   changes, and continuation shots that share a capKey without restating
//   `caption` keep the previous caption on screen.
// - `enter: true` animates the whole surface in (cards, first terminal shot).
// - Camera and source-aligned highlight changes animate over `motion` seconds.
// - Animated portions emit one state per frame at `fps`; holds emit a single
//   state carrying the remaining duration, so unique-frame count stays small.

const DEFAULT_CAMERA = Object.freeze({ x: 0.5, y: 0.5, scale: 1 });

/** Compare two small JSON-safe storyboard values. */
function equalValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Interpolate one camera target with a smooth start and finish. */
function interpolateCamera(from, to, progress) {
  const t = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    scale: from.scale + (to.scale - from.scale) * t,
  };
}

/** Interpolate a source-aligned highlight, fading when either endpoint is absent. */
function interpolateHighlight(from, to, progress) {
  if (!from && !to) return { highlight: null, highlightT: 0 };
  if (!from) return { highlight: to, highlightT: progress };
  if (!to) return { highlight: from, highlightT: 1 - progress };
  return {
    highlight: {
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
      width: from.width + (to.width - from.width) * progress,
      height: from.height + (to.height - from.height) * progress,
      label: to.label,
    },
    highlightT: 1,
  };
}

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
  let previousCamera = DEFAULT_CAMERA;
  let previousHighlight = null;
  let previousImage = null;
  let previousCameraKey = null;
  let previousHighlightKey = null;

  for (const shot of shots) {
    const caption =
      shot.caption ?? (shot.capKey && shot.capKey === previousCapKey ? previousCaption : null);
    const targetCamera = shot.kind === "term" ? (shot.camera ?? DEFAULT_CAMERA) : DEFAULT_CAMERA;
    const targetHighlight = shot.kind === "term" ? (shot.highlight ?? null) : null;
    const sharesCameraSource =
      shot.kind === "term" &&
      (shot.img === previousImage || (shot.cameraKey && shot.cameraKey === previousCameraKey));
    const sourceCamera =
      previousImage === null || sharesCameraSource ? previousCamera : targetCamera;
    const sharesHighlightSource =
      shot.kind === "term" &&
      (shot.img === previousImage ||
        (shot.highlightKey && shot.highlightKey === previousHighlightKey));
    const sourceHighlight = sharesHighlightSource ? previousHighlight : null;
    const base =
      shot.kind === "card"
        ? { kind: "card", html: shot.html }
        : { kind: "term", img: shot.img, title: shot.title, caption };
    const captionChanges = shot.kind === "term" && shot.caption && shot.capKey !== previousCapKey;
    const cameraChanges = shot.kind === "term" && !equalValue(sourceCamera, targetCamera);
    const highlightChanges = shot.kind === "term" && !equalValue(sourceHighlight, targetHighlight);
    const surfaceSeconds = shot.enter ? Math.min(captionAnimSeconds, shot.dur * 0.6) : 0;
    const captionSeconds = captionChanges ? Math.min(captionAnimSeconds, shot.dur * 0.6) : 0;
    const motionSeconds =
      cameraChanges || highlightChanges ? Math.min(shot.motion ?? 0.7, shot.dur * 0.6) : 0;
    const animSeconds = Math.max(surfaceSeconds, captionSeconds, motionSeconds);
    const animFrames = Math.round(animSeconds * fps);
    const surfaceFrames = Math.round(surfaceSeconds * fps);
    const captionFrames = Math.round(captionSeconds * fps);
    const motionFrames = Math.round(motionSeconds * fps);

    for (let k = 0; k < animFrames; k += 1) {
      const shotT = surfaceFrames > 0 ? Math.min((k + 1) / surfaceFrames, 1) : 1;
      const capT = captionFrames > 0 ? Math.min((k + 1) / captionFrames, 1) : 1;
      const motionT = motionFrames > 0 ? Math.min((k + 1) / motionFrames, 1) : 1;
      const highlightState = interpolateHighlight(sourceHighlight, targetHighlight, motionT);
      frames.push({
        state: {
          ...base,
          shotT,
          capT,
          camera: interpolateCamera(sourceCamera, targetCamera, motionT),
          ...highlightState,
          highlightPulseT: motionT,
        },
        duration: 1 / fps,
      });
    }
    frames.push({
      state: {
        ...base,
        shotT: 1,
        capT: 1,
        camera: targetCamera,
        highlight: targetHighlight,
        highlightT: targetHighlight ? 1 : 0,
        highlightPulseT: 1,
      },
      duration: Math.max(shot.dur - animFrames / fps, 1 / fps),
    });

    if (shot.kind === "term" && shot.caption) {
      previousCapKey = shot.capKey;
      previousCaption = shot.caption;
    } else if (shot.kind === "card") {
      previousCapKey = null;
      previousCaption = null;
    }
    previousCamera = targetCamera;
    previousHighlight = targetHighlight;
    previousImage = shot.kind === "term" ? shot.img : null;
    previousCameraKey = shot.kind === "term" ? (shot.cameraKey ?? null) : null;
    previousHighlightKey = shot.kind === "term" ? (shot.highlightKey ?? null) : null;
  }

  const totalSeconds = frames.reduce((sum, frame) => sum + frame.duration, 0);
  return { frames, totalSeconds };
}

/** Names of the terminal keyframes a storyboard needs on disk. */
export function requiredKeyframes(shots) {
  return [...new Set(shots.filter((shot) => shot.kind === "term").map((shot) => shot.img))];
}
