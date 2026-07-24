export const DEFAULT_TAB_WIDTH = 4;
export const MIN_TAB_WIDTH = 1;
export const MAX_TAB_WIDTH = 16;

/** Validate one numeric tab width while keeping rendering allocations practical. */
export function validateTabWidth(value: number, label = "tab width") {
  if (!Number.isSafeInteger(value) || value < MIN_TAB_WIDTH || value > MAX_TAB_WIDTH) {
    throw new Error(
      `Invalid ${label}: ${String(value)} (expected ${MIN_TAB_WIDTH}-${MAX_TAB_WIDTH})`,
    );
  }

  return value;
}

/** Parse one CLI tab-width argument. */
export function parseTabWidth(value: string) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`Invalid tab width: ${value}`);
  }

  return validateTabWidth(Number(value));
}
