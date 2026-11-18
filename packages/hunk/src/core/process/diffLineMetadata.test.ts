import { describe, expect, test } from "bun:test";
import {
  formatDiffLineMetadataHandshake,
  formatDiffLineMetadataRecord,
  negotiateDiffLineMetadataVersion,
} from "./diffLineMetadata";

describe("diff line metadata", () => {
  test("negotiates v1 from the host's version set in any order", () => {
    expect(negotiateDiffLineMetadataVersion({ OSC1717: "V1" })).toBe(1);
    expect(negotiateDiffLineMetadataVersion({ OSC1717: "V3, V1" })).toBe(1);
    expect(negotiateDiffLineMetadataVersion({ OSC1717: "V2" })).toBeNull();
    expect(negotiateDiffLineMetadataVersion({ OSC1717: "" })).toBeNull();
    expect(negotiateDiffLineMetadataVersion({})).toBeNull();
  });

  test("formats the version-only handshake", () => {
    expect(formatDiffLineMetadataHandshake()).toBe("\x1b]1717;1\x1b\\");
  });

  test("keeps line fields to the ones each record type carries", () => {
    expect(formatDiffLineMetadataRecord({ type: "f", newLine: 4, path: "src/a.ts" })).toBe(
      "\x1b]1717;1;f;;;src/a.ts\x1b\\",
    );
    expect(formatDiffLineMetadataRecord({ type: "a", newLine: 4, oldLine: 3, path: "a.ts" })).toBe(
      "\x1b]1717;1;a;4;;a.ts\x1b\\",
    );
    expect(
      formatDiffLineMetadataRecord({ type: "d", newLine: 4, oldLine: 3, path: "a;b.ts" }),
    ).toBe("\x1b]1717;1;d;4;3;a;b.ts\x1b\\");
  });

  test("drops a record whose path would break the escape sequence", () => {
    expect(formatDiffLineMetadataRecord({ type: "c", newLine: 1, path: "evil\x1b\\.ts" })).toBe("");
    expect(formatDiffLineMetadataRecord({ type: "c", newLine: 1, path: "" })).toBe("");
  });
});
