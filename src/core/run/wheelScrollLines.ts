export const DEFAULT_WHEEL_SCROLL_LINES = "auto" as const;
export const MIN_WHEEL_SCROLL_LINES = 1;
export const MAX_WHEEL_SCROLL_LINES = 10;

export type WheelScrollLines = typeof DEFAULT_WHEEL_SCROLL_LINES | number;

/** Validate one wheel-scroll preference while keeping each event within a practical range. */
export function validateWheelScrollLines(value: number, label = "wheel scroll lines") {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_WHEEL_SCROLL_LINES ||
    value > MAX_WHEEL_SCROLL_LINES
  ) {
    throw new Error(
      `Invalid ${label}: ${String(value)} (expected ${MIN_WHEEL_SCROLL_LINES}-${MAX_WHEEL_SCROLL_LINES} or auto)`,
    );
  }

  return value;
}

/** Parse one CLI wheel-scroll argument. */
export function parseWheelScrollLines(value: string): WheelScrollLines {
  if (value === DEFAULT_WHEEL_SCROLL_LINES) {
    return value;
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`Invalid wheel scroll lines: ${value}`);
  }

  return validateWheelScrollLines(Number(value));
}
