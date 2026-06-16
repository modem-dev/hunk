import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSkippedBinaryMetadata, isProbablyBinaryFile, patchLooksBinary } from "./binary";

describe("patchLooksBinary", () => {
  test("detects Git's textual binary marker", () => {
    expect(patchLooksBinary("diff --git a/x b/x\nBinary files a/x and b/x differ\n")).toBe(true);
  });

  test("detects the marker on the final line without a trailing newline", () => {
    expect(patchLooksBinary("Binary files a/x and b/x differ")).toBe(true);
  });

  test("detects an embedded GIT binary patch block", () => {
    expect(patchLooksBinary("diff --git a/x b/x\nGIT binary patch\nliteral 4\n")).toBe(true);
  });

  test("detects a GIT binary patch marker at the very start of the string", () => {
    // The marker anchors to start-of-line, so a patch that opens with it (no leading
    // newline) is still detected — symmetric with the `Binary files ... differ` marker.
    expect(patchLooksBinary("GIT binary patch\nliteral 4\n")).toBe(true);
  });

  test("does not flag ordinary text diffs", () => {
    expect(patchLooksBinary("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n")).toBe(false);
  });

  test("does not flag a space-prefixed context line that mentions binary files", () => {
    // A hunk context line carries a leading space, so the `Binary files ... differ` header
    // pattern cannot anchor to it even when the wording matches exactly.
    expect(patchLooksBinary("@@ -1 +1 @@\n Binary files a/x and b/x differ\n+x\n")).toBe(false);
  });
});

describe("createSkippedBinaryMetadata", () => {
  test("produces partial, hunk-free placeholder metadata", () => {
    const metadata = createSkippedBinaryMetadata("logo.png");
    expect(metadata).toMatchObject({
      name: "logo.png",
      type: "change",
      hunks: [],
      isPartial: true,
    });
    expect(metadata.cacheKey).toBe("logo.png:binary-skipped");
  });

  test("honors an explicit file type", () => {
    expect(createSkippedBinaryMetadata("logo.png", "new").type).toBe("new");
  });
});

describe("isProbablyBinaryFile", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hunk-binary-test-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write fixture bytes to a uniquely named file in the temp dir and return its path. */
  function writeFixture(name: string, bytes: Buffer | string) {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, bytes);
    return filePath;
  }

  test("treats a plain UTF-8 text file as non-binary", () => {
    const file = writeFixture("text.txt", "const value = 1;\nconst other = 2;\n");
    expect(isProbablyBinaryFile(file)).toBe(false);
  });

  test("treats text with tabs and newlines as non-binary", () => {
    const file = writeFixture("tabs.txt", "a\tb\nc\r\nd\n");
    expect(isProbablyBinaryFile(file)).toBe(false);
  });

  test("flags a file containing a NUL byte immediately", () => {
    // Avoid the Windows-reserved device name "NUL" regardless of extension.
    const file = writeFixture("null-byte.bin", Buffer.from([0x61, 0x62, 0x00, 0x63]));
    expect(isProbablyBinaryFile(file)).toBe(true);
  });

  test("flags a file at or above the 30% control-byte threshold", () => {
    // Exactly at the threshold: 7 printable bytes + 3 control bytes = 30% control, no NUL present.
    const file = writeFixture(
      "noisy.bin",
      Buffer.from([0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x01, 0x02, 0x03]),
    );
    expect(isProbablyBinaryFile(file)).toBe(true);
  });

  test("keeps a file below the control-byte threshold as non-binary", () => {
    // 1 control byte out of 10 = 10%, under the 30% cutoff.
    const file = writeFixture(
      "mild.bin",
      Buffer.from([0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x01]),
    );
    expect(isProbablyBinaryFile(file)).toBe(false);
  });

  test("treats an empty file as non-binary", () => {
    const file = writeFixture("empty.txt", "");
    expect(isProbablyBinaryFile(file)).toBe(false);
  });

  test("returns false for a missing file instead of throwing", () => {
    expect(isProbablyBinaryFile(path.join(dir, "does-not-exist.bin"))).toBe(false);
  });
});
