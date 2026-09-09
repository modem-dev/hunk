// Hand-written declarations for plan.mjs, which stays plain JS so the Node
// compositor can import it without a build step.

/** One storyboard beat. */
export interface Shot {
  kind: "card" | "term";
  /** Seconds this shot occupies. */
  dur: number;
  /** Card HTML (kind: "card"). */
  html?: string;
  /** Keyframe name without extension (kind: "term"). */
  img?: string;
  /** Terminal window title (kind: "term"). */
  title?: string;
  /** Caption HTML; omit on continuation shots to keep the previous caption. */
  caption?: string;
  /** Caption identity — the caption animates only when this changes. */
  capKey?: string;
  /** Animate the whole surface in (cards, first terminal shot). */
  enter?: boolean;
  /** Source-relative camera center and zoom; omitted terminal shots use the full frame. */
  camera?: CameraTarget;
  /** Identity shared by captured frames whose camera coordinates are compatible. */
  cameraKey?: string;
  /** Source-relative rectangle outlined over the terminal frame. */
  highlight?: HighlightTarget;
  /** Identity shared by captured frames whose highlight coordinates are compatible. */
  highlightKey?: string;
  /** Seconds used to animate camera and highlight changes. */
  motion?: number;
}

/** A camera target in normalized source coordinates. */
export interface CameraTarget {
  x: number;
  y: number;
  scale: number;
}

/** An outlined source region in normalized source coordinates. */
export interface HighlightTarget {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
}

/** A renderable frame state handed to the stage's renderShot. */
export interface FrameState {
  kind: "card" | "term";
  html?: string;
  img?: string;
  title?: string;
  caption?: string | null;
  camera?: CameraTarget;
  highlight?: HighlightTarget | null;
  highlightT?: number;
  highlightPulseT?: number;
  shotT: number;
  capT: number;
}

export interface PlannedFrame {
  state: FrameState;
  duration: number;
}

export function planFrames(
  shots: Shot[],
  options?: { fps?: number; captionAnimSeconds?: number },
): { frames: PlannedFrame[]; totalSeconds: number };

export function requiredKeyframes(shots: Shot[]): string[];
