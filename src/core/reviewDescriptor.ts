import type { ExtensionReviewDescriptor } from "../extension-api/types";

const REVIEW_DESCRIPTOR_TOTAL_BYTES = 4 * 1024;
const REVIEW_DESCRIPTOR_FIELD_LIMITS = Object.freeze({
  provider: 256,
  title: 2 * 1024,
  url: 2 * 1024,
  id: 256,
  repository: 512,
  author: 512,
  base: 512,
  head: 512,
  revision: 512,
});

/** Measure a public descriptor string in transport bytes rather than UTF-16 code units. */
function descriptorByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

/** Validate one bounded terminal-safe descriptor string. */
function validateDescriptorString(
  candidate: Record<string, unknown>,
  field: keyof typeof REVIEW_DESCRIPTOR_FIELD_LIMITS,
  required: boolean,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(candidate, field)) {
    if (!required) return undefined;
    throw new Error(`delegate review ${field} must be a non-empty string`);
  }
  const value = candidate[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`delegate review ${field} must be a non-empty string`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`delegate review ${field} cannot contain control characters`);
  }
  if (descriptorByteLength(value) > REVIEW_DESCRIPTOR_FIELD_LIMITS[field]) {
    throw new Error(`delegate review ${field} exceeds its byte limit`);
  }
  return value;
}

/** Copy only present optional fields after applying their individual bounds. */
function copyOptionalDescriptorFields(
  candidate: Record<string, unknown>,
  fields: readonly (keyof typeof REVIEW_DESCRIPTOR_FIELD_LIMITS)[],
): Record<string, string> {
  const copied: Record<string, string> = {};
  for (const field of fields) {
    const value = validateDescriptorString(candidate, field, false);
    if (value !== undefined) copied[field] = value;
  }
  return copied;
}

/** Validate optional provider change-request state. */
function validateChangeRequestState(value: unknown): "open" | "closed" | "merged" | undefined {
  if (value === undefined || value === "open" || value === "closed" || value === "merged") {
    return value;
  }
  throw new Error('delegate review state must be "open", "closed", or "merged"');
}

/** Validate an optional boolean descriptor field. */
function validateOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value;
  throw new Error(`delegate review ${field} must be a boolean`);
}

/** Validate, copy, and deeply freeze provider-neutral delegated review metadata. */
export function validateExtensionReviewDescriptor(value: unknown): ExtensionReviewDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("delegate review must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("delegate review must be a plain object");
  }
  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind;
  if (
    !Object.prototype.hasOwnProperty.call(candidate, "kind") ||
    (kind !== "change-request" && kind !== "commit" && kind !== "comparison")
  ) {
    throw new Error('delegate review kind must be "change-request", "commit", or "comparison"');
  }

  const common = ["kind", "provider", "title", "url"];
  const kindFields =
    kind === "change-request"
      ? ["id", "repository", "author", "base", "head", "state", "draft"]
      : kind === "commit"
        ? ["revision", "author"]
        : ["base", "head"];
  const allowed = new Set([...common, ...kindFields]);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new Error("delegate review contains unknown fields");
  }

  const provider = validateDescriptorString(candidate, "provider", true)!;
  const title = validateDescriptorString(candidate, "title", true)!;
  const url = validateDescriptorString(candidate, "url", false);
  if (url !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("delegate review url must be a valid HTTPS URL");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("delegate review url must be a credential-free HTTPS URL");
    }
  }

  let descriptor: ExtensionReviewDescriptor;
  if (kind === "change-request") {
    const state = validateChangeRequestState(candidate.state);
    const draft = validateOptionalBoolean(candidate.draft, "draft");
    descriptor = {
      kind,
      provider,
      title,
      ...(url === undefined ? {} : { url }),
      id: validateDescriptorString(candidate, "id", true)!,
      ...copyOptionalDescriptorFields(candidate, ["repository", "author", "base", "head"]),
      ...(state === undefined ? {} : { state }),
      ...(draft === undefined ? {} : { draft }),
    };
  } else if (kind === "commit") {
    descriptor = {
      kind,
      provider,
      title,
      ...(url === undefined ? {} : { url }),
      revision: validateDescriptorString(candidate, "revision", true)!,
      ...copyOptionalDescriptorFields(candidate, ["author"]),
    };
  } else {
    descriptor = {
      kind,
      provider,
      title,
      ...(url === undefined ? {} : { url }),
      base: validateDescriptorString(candidate, "base", true)!,
      head: validateDescriptorString(candidate, "head", true)!,
    };
  }

  const totalBytes = descriptorByteLength(JSON.stringify(descriptor));
  if (totalBytes > REVIEW_DESCRIPTOR_TOTAL_BYTES) {
    throw new Error("delegate review exceeds the total byte limit");
  }
  return Object.freeze(descriptor);
}

/** Parse untrusted review metadata without throwing at a wire boundary. */
export function parseExtensionReviewDescriptor(value: unknown): ExtensionReviewDescriptor | null {
  try {
    return validateExtensionReviewDescriptor(value);
  } catch {
    return null;
  }
}
