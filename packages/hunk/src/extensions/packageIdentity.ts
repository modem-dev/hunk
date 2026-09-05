const EXTENSION_PACKAGE_ID_MAX_LENGTH = 128;
const EXTENSION_PACKAGE_METADATA_MAX_LENGTH = 160;
const EXTENSION_PACKAGE_ID_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;
const FALLBACK_PACKAGE_SEPARATOR_PATTERN = /[^a-z0-9._-]+/g;
const FALLBACK_PACKAGE_LEADING_PATTERN = /^[^a-z0-9]+/;

/** Validate one manifest-owned package identity before it reaches activation state. */
export function normalizeExtensionPackageId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (
    id.length === 0 ||
    id.length > EXTENSION_PACKAGE_ID_MAX_LENGTH ||
    !EXTENSION_PACKAGE_ID_PATTERN.test(id)
  ) {
    return undefined;
  }
  return id;
}

/** Canonicalize a legacy folder/install name into a manageable package identity. */
export function normalizeFallbackExtensionPackageId(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(FALLBACK_PACKAGE_SEPARATOR_PATTERN, "-")
    .replace(FALLBACK_PACKAGE_LEADING_PATTERN, "")
    .slice(0, EXTENSION_PACKAGE_ID_MAX_LENGTH);
  return normalizeExtensionPackageId(normalized) ?? "extension";
}

/** Bound extension metadata and remove terminal controls before display. */
export function sanitizeExtensionPackageDisplay(value: string) {
  return value
    .replace(TERMINAL_CONTROL_PATTERN, "")
    .slice(0, EXTENSION_PACKAGE_METADATA_MAX_LENGTH);
}
