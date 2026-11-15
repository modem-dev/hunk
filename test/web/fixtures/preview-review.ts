/**
 * Writes a git repository whose staged changes exercise the rich previews: real PNG images
 * changed, added, and deleted (with transparency), a binary file named like an image that is
 * not one, a tiny PNG declaring 30000 × 30000, SVGs carrying script (one text, one binary),
 * and Markdown files changed and deleted with adversarial content.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { reviewOrderSidecarPath } from "./rich-review";

/** Every path of the preview review, in review order. */
export const PREVIEW_REVIEW_PATHS: readonly string[] = [
  "images/photo.png",
  "images/added.png",
  "images/removed.png",
  "images/fake.png",
  "docs/guide.md",
  "docs/removed.md",
  "images/huge.png",
  "images/script.svg",
  "images/packed.svg",
];

/** An SVG that would run script if it were ever rendered as a document. */
export const SCRIPT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">\n' +
  "<script>window.__hunkSvgPwned = true</script>\n" +
  '<rect width="8" height="8" fill="red"/>\n' +
  "</svg>\n";

const CRC_TABLE = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** CRC-32 as PNG chunks use it. */
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk. */
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(
    Array.from(type, (character) => character.charCodeAt(0)),
    4,
  );
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Encode an RGBA image as a PNG, coloring each pixel with `pixel(x, y)`.
 *
 * Exported for tests that need small, real images without a binary fixture in the repository.
 */
export function encodeTestPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
) {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0;
    for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), y * (1 + width * 4) + 1 + x * 4);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * A few-hundred-byte PNG whose header declares `width × height` but whose pixel data covers
 * one row: decoding it would allocate the declared size, so the preview must refuse it first.
 */
function declaredSizeTestPng(width: number, height: number) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(64)))),
    chunk("IEND", new Uint8Array()),
  ];
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}

/** Run one git command with a fixed identity. */
function git(repo: string, ...args: string[]) {
  execFileSync(
    "git",
    ["-c", "user.name=Hunk Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd: repo, stdio: "ignore" },
  );
}

/** Write one file, creating its directories. */
function write(repo: string, path: string, contents: string | Uint8Array) {
  const target = join(repo, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

const GUIDE_BEFORE = "# Guide\n\nThe old guide.\n";

/** The guide after the change: every supported block, plus content that must stay inert. */
export const GUIDE_AFTER = [
  "# Guide",
  "",
  "Read the **new** guide, with `inline code` and *emphasis*.",
  "",
  "<script>window.__hunkPwned = true</script>",
  "",
  "- [Safe link](https://example.com/docs)",
  "- [Script link](javascript:window.__hunkPwned=true)",
  "",
  "| Option | Default |",
  "|:-------|--------:|",
  "| width  | 80      |",
  "",
  "> A quoted aside.",
  "",
  "```sh",
  "hunk diff --web",
  "```",
  "",
].join("\n");

/** Build the preview review's repository at `repo` and stage its changes. */
export function writePreviewReviewRepo(repo: string) {
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  write(
    repo,
    "images/photo.png",
    encodeTestPng(48, 32, () => [220, 40, 40, 255]),
  );
  write(
    repo,
    "images/removed.png",
    encodeTestPng(16, 16, () => [40, 160, 60, 255]),
  );
  write(repo, "images/fake.png", Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 0, 3]));
  write(repo, "docs/guide.md", GUIDE_BEFORE);
  write(repo, "docs/removed.md", "# Removed\n\nThis page goes away.\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");

  // Blue, with a transparent right half, so the checkerboard shows through.
  write(
    repo,
    "images/photo.png",
    encodeTestPng(64, 32, (x) => (x < 32 ? [40, 80, 220, 255] : [40, 80, 220, 0])),
  );
  write(
    repo,
    "images/added.png",
    encodeTestPng(24, 24, (x, y) => [(x * 10) % 255, (y * 10) % 255, 128, 255]),
  );
  rmSync(join(repo, "images", "removed.png"));
  write(repo, "images/fake.png", Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0, 9, 9, 0, 3]));
  write(repo, "docs/guide.md", GUIDE_AFTER);
  rmSync(join(repo, "docs", "removed.md"));
  write(repo, "images/huge.png", declaredSizeTestPng(30_000, 30_000));
  write(repo, "images/script.svg", SCRIPT_SVG);
  // A NUL byte makes git treat this SVG as binary, so it reaches the image-preview slot.
  write(repo, "images/packed.svg", `${SCRIPT_SVG}\0`);
  git(repo, "add", "-A");
  writeFileSync(
    reviewOrderSidecarPath(repo),
    JSON.stringify({ version: 1, files: PREVIEW_REVIEW_PATHS.map((path) => ({ path })) }),
  );
}
