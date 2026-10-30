export type CanonicalJsonPrimitive = null | boolean | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
        throw new TypeError("Canonical JSON rejects lone Unicode surrogates.");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("Canonical JSON rejects lone Unicode surrogates.");
    }
  }
}

/** Serialize one JSON value using RFC 8785 key ordering and ECMAScript primitive encoding. */
export function canonicalizeJson(value: CanonicalJsonValue): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers.");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError("Canonical JSON rejects sparse arrays.");
      }
      entries.push(canonicalizeJson(value[index]!));
    }
    return `[${entries.join(",")}]`;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON requires plain JSON objects.");
    }
    const record = value as Record<string, CanonicalJsonValue>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        assertUnicodeScalarString(key);
        return `${JSON.stringify(key)}:${canonicalizeJson(record[key]!)}`;
      });
    return `{${entries.join(",")}}`;
  }

  throw new TypeError("Canonical JSON supports JSON values only.");
}

/** Encode canonical JSON as the exact UTF-8 bytes covered by broker signatures. */
export function canonicalJsonBytes(value: CanonicalJsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalizeJson(value));
}
