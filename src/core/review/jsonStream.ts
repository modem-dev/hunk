import { createHash } from "node:crypto";

export interface JsonStreamMeasurement {
  byteLength: number;
  digest: string;
}

/** Raised as soon as deterministic JSON output exceeds its configured byte bound. */
export class JsonStreamSizeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`JSON output exceeds the ${maxBytes}-byte limit.`);
    this.name = "JsonStreamSizeError";
  }
}

/** Apply JSON.stringify's object-specific `toJSON` conversion for one property key. */
function normalizeJsonValue(value: unknown, key: string) {
  if (!value || typeof value !== "object") return value;
  const toJSON = (value as { toJSON?: (key: string) => unknown }).toJSON;
  const normalized = typeof toJSON === "function" ? toJSON.call(value, key) : value;
  if (!normalized || typeof normalized !== "object") return normalized;
  const tag = Object.prototype.toString.call(normalized);
  if (tag === "[object Number]") return (normalized as { valueOf: () => number }).valueOf();
  if (tag === "[object String]") return (normalized as { valueOf: () => string }).valueOf();
  if (tag === "[object Boolean]") return (normalized as { valueOf: () => boolean }).valueOf();
  if (tag === "[object BigInt]") return (normalized as { valueOf: () => bigint }).valueOf();
  return normalized;
}

/** Return whether an object property would be omitted by JSON.stringify. */
function isOmittedObjectValue(value: unknown) {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/** Emit JSON.stringify's exact well-formed string escaping in bounded source slices. */
function visitJsonStringChunks(value: string, emit: (chunk: string) => void) {
  // Small strings dominate review records; native escaping is faster and remains strictly bounded.
  if (value.length <= 64 * 1024) {
    emit(JSON.stringify(value));
    return;
  }
  emit('"');
  let rawStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let escaped: string | undefined;
    if (code === 0x22) escaped = '\\"';
    else if (code === 0x5c) escaped = "\\\\";
    else if (code === 0x08) escaped = "\\b";
    else if (code === 0x0c) escaped = "\\f";
    else if (code === 0x0a) escaped = "\\n";
    else if (code === 0x0d) escaped = "\\r";
    else if (code === 0x09) escaped = "\\t";
    else if (code < 0x20) escaped = `\\u${code.toString(16).padStart(4, "0")}`;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else escaped = `\\u${code.toString(16)}`;
    } else if (code >= 0xdc00 && code <= 0xdfff) escaped = `\\u${code.toString(16)}`;
    if (escaped === undefined) {
      if (index - rawStart >= 16 * 1024) {
        emit(value.slice(rawStart, index + 1));
        rawStart = index + 1;
      }
      continue;
    }
    if (rawStart < index) emit(value.slice(rawStart, index));
    emit(escaped);
    rawStart = index + 1;
  }
  if (rawStart < value.length) emit(value.slice(rawStart));
  emit('"');
}

/** Visit JSON.stringify-compatible chunks without allocating the complete output string. */
function visitJsonChunks(
  input: unknown,
  key: string,
  emit: (chunk: string) => void,
  ancestors: Set<object>,
  inArray = false,
  normalized = false,
): boolean {
  const value = normalized ? input : normalizeJsonValue(input, key);
  if (isOmittedObjectValue(value)) {
    if (inArray) {
      emit("null");
      return true;
    }
    return false;
  }
  if (value === null) {
    emit("null");
    return true;
  }
  switch (typeof value) {
    case "string":
      visitJsonStringChunks(value, emit);
      return true;
    case "boolean":
    case "number": {
      const serialized = JSON.stringify(value);
      emit(serialized === undefined ? "null" : serialized);
      return true;
    }
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    case "object":
      break;
    default:
      return false;
  }

  const object = value as object;
  if (ancestors.has(object)) throw new TypeError("Converting circular structure to JSON");
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      emit("[");
      const length = object.length;
      for (let index = 0; index < length; index += 1) {
        if (index > 0) emit(",");
        visitJsonChunks(object[index], String(index), emit, ancestors, true);
      }
      emit("]");
      return true;
    }

    emit("{");
    let emitted = false;
    for (const propertyKey of Object.keys(object)) {
      const candidate = normalizeJsonValue(
        (object as Record<string, unknown>)[propertyKey],
        propertyKey,
      );
      if (isOmittedObjectValue(candidate)) continue;
      if (emitted) emit(",");
      visitJsonStringChunks(propertyKey, emit);
      emit(":");
      visitJsonChunks(candidate, propertyKey, emit, ancestors, false, true);
      emitted = true;
    }
    emit("}");
    return true;
  } finally {
    ancestors.delete(object);
  }
}

/** Measure and hash exact JSON.stringify UTF-8 bytes without retaining the full serialization. */
export function measureJsonStream(value: unknown, maxBytes = Number.POSITIVE_INFINITY) {
  const hash = createHash("sha256");
  const pending: string[] = [];
  let pendingBytes = 0;
  let byteLength = 0;

  /** Bound temporary joining while amortizing native hash updates across small JSON tokens. */
  const flush = () => {
    if (pending.length === 0) return;
    hash.update(pending.join(""), "utf8");
    pending.length = 0;
    pendingBytes = 0;
  };
  const emitted = visitJsonChunks(
    value,
    "",
    (chunk) => {
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      byteLength += chunkBytes;
      if (byteLength > maxBytes) throw new JsonStreamSizeError(maxBytes);
      if (pendingBytes + chunkBytes >= 64 * 1024) flush();
      if (chunkBytes >= 64 * 1024) hash.update(chunk, "utf8");
      else {
        pending.push(chunk);
        pendingBytes += chunkBytes;
      }
    },
    new Set(),
  );
  if (!emitted) throw new TypeError("JSON root value is not serializable.");
  flush();
  return { byteLength, digest: hash.digest("hex") } satisfies JsonStreamMeasurement;
}
