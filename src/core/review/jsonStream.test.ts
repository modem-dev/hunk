import { describe, expect, test } from "bun:test";
import { reviewDigest } from "./identity";
import { JsonStreamSizeError, measureJsonStream } from "./jsonStream";

const parityValues: unknown[] = [
  null,
  true,
  false,
  0,
  -0,
  1.25,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "ASCII",
  'quote " slash \\ controls \b\f\n\r\t\u0000',
  "中文レビュー",
  "emoji 🧪🚀",
  "lone-high-\ud800 lone-low-\udc00",
  [1, undefined, null, "x", { omitted: undefined, retained: true }],
  {
    z: 1,
    a: ["line\n", { nested: "value" }],
    omitted: undefined,
    finite: 42,
    nonFinite: Number.NaN,
  },
];

describe("measureJsonStream", () => {
  test.each(parityValues)("matches JSON.stringify bytes and digest for %#", (value) => {
    const serialized = JSON.stringify(value)!;
    expect(measureJsonStream(value)).toEqual({
      byteLength: Buffer.byteLength(serialized, "utf8"),
      digest: reviewDigest(serialized),
    });
  });

  test("matches bounded streaming for large escaped and Unicode strings", () => {
    const value = `${"x".repeat(70_000)}\n中文🧪\ud800${"y".repeat(70_000)}`;
    const serialized = JSON.stringify(value);
    expect(measureJsonStream(value)).toEqual({
      byteLength: Buffer.byteLength(serialized, "utf8"),
      digest: reviewDigest(serialized),
    });
  });

  test("matches boxed primitive and fixed array-length semantics", () => {
    const boxed = {
      number: new Number(12.5),
      string: new String("boxed 🧪"),
      boolean: new Boolean(false),
    };
    const serialized = JSON.stringify(boxed);
    expect(measureJsonStream(boxed)).toEqual({
      byteLength: Buffer.byteLength(serialized, "utf8"),
      digest: reviewDigest(serialized),
    });
    expect(() => measureJsonStream(Object(1n))).toThrow(TypeError);

    const growing = ["first"];
    Object.defineProperty(growing, 0, {
      enumerable: true,
      get: () => {
        growing.push("late");
        return "first";
      },
    });
    const expected = JSON.stringify(growing);
    growing.length = 1;
    expect(measureJsonStream(growing)).toEqual({
      byteLength: Buffer.byteLength(expected, "utf8"),
      digest: reviewDigest(expected),
    });
  });

  test("matches property ordering and toJSON behavior", () => {
    const sparse = Array<unknown>(3);
    sparse[0] = { toJSON: (key: string) => key };
    sparse[2] = undefined;
    const value = {
      first: 1,
      converted: { toJSON: (key: string) => ({ key, value: "ok" }) },
      array: sparse,
    };
    const serialized = JSON.stringify(value);
    expect(measureJsonStream(value)).toEqual({
      byteLength: Buffer.byteLength(serialized, "utf8"),
      digest: reviewDigest(serialized),
    });
  });

  test("rejects ASCII and valid-surrogate-pair streams before visiting later properties", () => {
    for (const large of ["x".repeat(1024 * 1024), "🧪".repeat(512 * 1024)]) {
      let visitedTail = false;
      const value = {
        large,
        get tail() {
          visitedTail = true;
          return "not visited";
        },
      };
      expect(() => measureJsonStream(value, 32)).toThrow(JsonStreamSizeError);
      expect(visitedTail).toBe(false);
    }
  });

  test("rejects unsupported roots, bigint, and cycles like JSON.stringify", () => {
    expect(() => measureJsonStream(undefined)).toThrow("not serializable");
    expect(() => measureJsonStream(1n)).toThrow(TypeError);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => measureJsonStream(cycle)).toThrow(TypeError);
  });
});
