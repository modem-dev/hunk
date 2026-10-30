import { describe, expect, test } from "bun:test";
import { canonicalizeJson } from "./canonicalJson";

describe("RFC 8785 canonical JSON", () => {
  test("matches the RFC primitive and UTF-16 property ordering examples", () => {
    expect(
      canonicalizeJson({
        numbers: [333333333.3333333, 1e30, 4.5, 0.002, 1e-27],
        string: '€$\u000f\nA\'B"\\"/',
        literals: [null, true, false],
      }),
    ).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\\"\\\\\\\"/"}',
    );
    expect(canonicalizeJson({ "\u20ac": "Euro", "\r": "CR", "1": "one" })).toBe(
      '{"\\r":"CR","1":"one","€":"Euro"}',
    );
  });

  test("rejects values JSON cannot represent deterministically", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => canonicalizeJson(Number.NaN)).toThrow("non-finite");
    expect(() => canonicalizeJson(Number.POSITIVE_INFINITY)).toThrow("non-finite");
    expect(() => canonicalizeJson("\ud800")).toThrow("surrogates");
    expect(() => canonicalizeJson(sparse as never)).toThrow("sparse");
    expect(() => canonicalizeJson(new Date() as never)).toThrow("plain JSON objects");
  });
});
