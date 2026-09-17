export const DEFAULT_SCROLL_OFF = 0;
export const MIN_SCROLL_OFF = 0;
export const MAX_SCROLL_OFF = 40;

/** Validate one scrolloff margin while keeping it within a practical viewport fraction. */
export function validateScrollOff(value: number, label = "scroll off") {
  if (!Number.isSafeInteger(value) || value < MIN_SCROLL_OFF || value > MAX_SCROLL_OFF) {
    throw new Error(
      `Invalid ${label}: ${String(value)} (expected ${MIN_SCROLL_OFF}-${MAX_SCROLL_OFF})`,
    );
  }

  return value;
}

/** Parse one CLI scroll-off argument. */
export function parseScrollOff(value: string) {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Invalid scroll off: ${value}`);
  }

  return validateScrollOff(Number(value));
}
