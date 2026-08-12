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
}

/** A renderable frame state handed to the stage's renderShot. */
export interface FrameState {
  kind: "card" | "term";
  html?: string;
  img?: string;
  title?: string;
  caption?: string | null;
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
