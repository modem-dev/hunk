import { describe, expect, test } from "bun:test";
import {
  assertReviewPublicationAdvance,
  classifyReviewPublication,
  formatReviewGeneration,
  nextReviewGeneration,
  parseReviewGeneration,
  ReviewPublicationOrderError,
} from "./generationOrder";

const producer = "p1";
const generation = (sequence: number) => formatReviewGeneration({ producerId: producer, sequence });
const at = (sequence: number, stateRevision: number) => ({
  generation: generation(sequence),
  stateRevision,
});

describe("review generation identity", () => {
  test("round-trips through its serialized form", () => {
    expect(parseReviewGeneration(generation(7))).toEqual({ producerId: producer, sequence: 7 });
  });

  // Intent: the parser's digit bound was narrower than the range the formatter accepts, so
  // a producer that lived long enough to pass 10^15 would publish generations nothing could
  // read back. Every sequence the formatter writes must parse.
  test("round-trips every sequence the formatter accepts", () => {
    for (const sequence of [
      0,
      999_999_999_999_999,
      1_000_000_000_000_000,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const formatted = formatReviewGeneration({ producerId: producer, sequence });
      expect(parseReviewGeneration(formatted)).toEqual({ producerId: producer, sequence });
    }
  });

  test("rejects a sequence past the safe-integer range", () => {
    expect(parseReviewGeneration(`generation:${producer}:9007199254740993`)).toBeUndefined();
  });

  test("rejects identities outside the grammar", () => {
    for (const value of [
      "generation:p1",
      "generation::3",
      "generation:p 1:3",
      "gen:p1:3",
      "generation:p1:-1",
      "generation:p1:3.5",
      42,
      undefined,
    ]) {
      expect(parseReviewGeneration(value)).toBeUndefined();
    }
  });

  test("refuses to format an identity it could not parse back", () => {
    expect(() => formatReviewGeneration({ producerId: "a:b", sequence: 1 })).toThrow();
    expect(() => formatReviewGeneration({ producerId: producer, sequence: -1 })).toThrow();
  });

  test("advances one sequence at a time", () => {
    expect(nextReviewGeneration({ producerId: producer, sequence: 4 })).toEqual({
      producerId: producer,
      sequence: 5,
    });
  });
});

describe("classifyReviewPublication", () => {
  test("accepts a further revision of the same generation", () => {
    expect(classifyReviewPublication(at(1, 3), at(1, 4))).toBe("accepted");
  });

  // Intent: revision jumps are legal — snapshots and replay skip, and the prototype's
  // contiguous `+1` requirement is exactly the bug this rule replaces (C1).
  test("accepts a revision that skips ahead within one generation", () => {
    expect(classifyReviewPublication(at(1, 3), at(1, 9))).toBe("accepted");
  });

  test("treats a repeated or earlier revision as a replay", () => {
    expect(classifyReviewPublication(at(1, 3), at(1, 3))).toBe("stale");
    expect(classifyReviewPublication(at(1, 3), at(1, 2))).toBe("stale");
  });

  test("reports a later generation as a gap, whatever its revision says", () => {
    expect(classifyReviewPublication(at(1, 9), at(2, 0))).toBe("gap");
    expect(classifyReviewPublication(at(1, 9), at(4, 0))).toBe("gap");
  });

  test("treats an earlier generation as stale even at a higher revision", () => {
    expect(classifyReviewPublication(at(3, 0), at(2, 99))).toBe("stale");
  });

  test("never orders two producers against each other", () => {
    expect(
      classifyReviewPublication(at(1, 0), {
        generation: formatReviewGeneration({ producerId: "p2", sequence: 9 }),
        stateRevision: 9,
      }),
    ).toBe("stale");
  });

  test("treats an unparseable identity on either side as stale", () => {
    expect(classifyReviewPublication(at(1, 0), { generation: "nope", stateRevision: 5 })).toBe(
      "stale",
    );
    expect(classifyReviewPublication({ generation: "nope", stateRevision: 0 }, at(1, 5))).toBe(
      "stale",
    );
  });
});

describe("assertReviewPublicationAdvance", () => {
  test("permits a further revision and the very next generation", () => {
    expect(() => assertReviewPublicationAdvance(at(1, 2), at(1, 3))).not.toThrow();
    expect(() => assertReviewPublicationAdvance(at(1, 2), at(2, 0))).not.toThrow();
  });

  test("refuses a republication at the same position", () => {
    expect(() => assertReviewPublicationAdvance(at(1, 2), at(1, 2))).toThrow(
      ReviewPublicationOrderError,
    );
  });

  test("refuses a producer that skips a generation", () => {
    expect(() => assertReviewPublicationAdvance(at(1, 2), at(3, 0))).toThrow(
      ReviewPublicationOrderError,
    );
  });
});
