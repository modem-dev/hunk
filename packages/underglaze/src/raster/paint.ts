/**
 * Colors and the paints that fill shapes.
 *
 * A paint is a function from normalized shape coordinates to a color, which
 * keeps gradients independent of where a shape ends up: the same paint fills a
 * 40-pixel pill and a full-width panel without rescaling its stops.
 */
import type { Rgba } from "./pixmap";

export type { Rgba };

/**
 * Fills a shape. `u` runs 0..1 left to right across the shape's bounding box,
 * `v` runs 0..1 top to bottom.
 */
export type Paint = (u: number, v: number) => Rgba;

/** Accepts either a parsed color or the CSS-style hex shorthand. */
export type ColorInput = string | Rgba;

const HEX = /^#?([0-9a-f]{3,8})$/i;

/**
 * Parses `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa` into a color.
 *
 * Alpha defaults to opaque, matching how these strings read in a stylesheet.
 */
export function parseColor(input: ColorInput): Rgba {
  if (typeof input !== "string") return input;
  const match = HEX.exec(input.trim());
  if (!match) throw new Error(`unrecognized color: ${input}`);
  const hex = match[1]!;
  const expand = (s: string) => Number.parseInt(s.length === 1 ? s + s : s, 16);
  if (hex.length === 3 || hex.length === 4) {
    return [
      expand(hex[0]!),
      expand(hex[1]!),
      expand(hex[2]!),
      hex.length === 4 ? expand(hex[3]!) : 255,
    ];
  }
  if (hex.length === 6 || hex.length === 8) {
    return [
      expand(hex.slice(0, 2)),
      expand(hex.slice(2, 4)),
      expand(hex.slice(4, 6)),
      hex.length === 8 ? expand(hex.slice(6, 8)) : 255,
    ];
  }
  throw new Error(`unrecognized color: ${input}`);
}

/** Mixes two colors, `t` running 0 at `a` to 1 at `b`. */
export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const k = Math.min(Math.max(t, 0), 1);
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
    a[3] + (b[3] - a[3]) * k,
  ];
}

/** Multiplies a color's alpha, for shadows and disabled states. */
export function withAlpha(color: ColorInput, alpha: number): Rgba {
  const c = parseColor(color);
  return [c[0], c[1], c[2], c[3] * Math.min(Math.max(alpha, 0), 1)];
}

/** A single flat color. */
export function solid(color: ColorInput): Paint {
  const c = parseColor(color);
  return () => c;
}

export interface GradientStop {
  /** Position along the gradient, 0 to 1. */
  offset: number;
  color: ColorInput;
}

/** Normalizes and sorts stops so sampling can assume ordered, parsed input. */
function prepareStops(stops: GradientStop[]): Array<{ offset: number; color: Rgba }> {
  if (stops.length === 0) throw new Error("a gradient needs at least one stop");
  return stops
    .map((s) => ({ offset: Math.min(Math.max(s.offset, 0), 1), color: parseColor(s.color) }))
    .sort((a, b) => a.offset - b.offset);
}

/** Samples prepared stops at `t`, holding the end colors beyond the outermost stops. */
function sampleStops(stops: Array<{ offset: number; color: Rgba }>, t: number): Rgba {
  const first = stops[0]!;
  if (t <= first.offset) return first.color;
  const last = stops[stops.length - 1]!;
  if (t >= last.offset) return last.color;
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1]!;
    const next = stops[i]!;
    if (t <= next.offset) {
      const span = next.offset - prev.offset;
      return span <= 0 ? next.color : mix(prev.color, next.color, (t - prev.offset) / span);
    }
  }
  return last.color;
}

/**
 * A linear gradient across the shape's bounding box.
 *
 * `angle` is in degrees clockwise from vertical, so the default of 0 runs top
 * to bottom — the direction most panel and button chrome uses.
 */
export function linearGradient(stops: GradientStop[], angle = 0): Paint {
  const prepared = prepareStops(stops);
  const radians = (angle * Math.PI) / 180;
  const dx = Math.sin(radians);
  const dy = Math.cos(radians);
  // Project the unit square onto the gradient axis so t still spans 0..1 at any angle.
  const extent = Math.abs(dx) + Math.abs(dy);
  return (u, v) => {
    const cu = u - 0.5;
    const cv = v - 0.5;
    const t = (cu * dx + cv * dy) / extent + 0.5;
    return sampleStops(prepared, t);
  };
}

/** Convenience for the common two-stop vertical ramp. */
export function verticalGradient(from: ColorInput, to: ColorInput): Paint {
  return linearGradient([
    { offset: 0, color: from },
    { offset: 1, color: to },
  ]);
}

/**
 * A radial gradient centered in the shape's bounding box.
 *
 * The box is treated as square while sampling, so the falloff stays circular in
 * a wide shape instead of stretching into an ellipse.
 */
export function radialGradient(stops: GradientStop[]): Paint {
  const prepared = prepareStops(stops);
  return (u, v) => {
    const du = (u - 0.5) * 2;
    const dv = (v - 0.5) * 2;
    return sampleStops(prepared, Math.min(1, Math.hypot(du, dv)));
  };
}

/** Layers one paint over another, honoring the top paint's alpha. */
export function over(top: Paint, bottom: Paint): Paint {
  return (u, v) => {
    const t = top(u, v);
    const b = bottom(u, v);
    const a = t[3] / 255;
    return [
      t[0] * a + b[0] * (1 - a),
      t[1] * a + b[1] * (1 - a),
      t[2] * a + b[2] * (1 - a),
      Math.max(t[3], b[3]),
    ];
  };
}
