import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveReviewPageAssets,
  directoryReviewPageAssets,
  encodeReviewPageAssetArchive,
  parseReviewPageAssetManifest,
  reviewAssetContentType,
  REVIEW_PAGE_DOCUMENT_NAME,
  REVIEW_PAGE_MANIFEST_NAME,
  type ReviewPageAssetManifestV1,
} from "./reviewPageAssets";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const MANIFEST: ReviewPageAssetManifestV1 = {
  formatVersion: 1,
  assets: ["main-abc123.js", "main-abc123.css"],
};

const FILES = new Map<string, Uint8Array<ArrayBuffer>>([
  [REVIEW_PAGE_DOCUMENT_NAME, new TextEncoder().encode("<!doctype html><title>t</title>")],
  ["main-abc123.js", new TextEncoder().encode("console.log(1);")],
  ["main-abc123.css", new TextEncoder().encode("body{margin:0}")],
]);

/** Write one page build directory with an extra unlisted file beside the listed ones. */
function writeTestBuild(manifest: unknown = MANIFEST) {
  const directory = mkdtempSync(join(tmpdir(), "hunk-page-assets-"));
  directories.push(directory);
  for (const [name, bytes] of FILES) {
    writeFileSync(join(directory, name), bytes);
  }
  writeFileSync(join(directory, "unlisted.js"), "secret();");
  writeFileSync(join(directory, REVIEW_PAGE_MANIFEST_NAME), JSON.stringify(manifest));
  return directory;
}

describe("review page manifest", () => {
  test("accepts flat hashed names with a known content type", () => {
    expect(parseReviewPageAssetManifest(MANIFEST)).toEqual(MANIFEST);
  });

  test("refuses traversal, separators, and unknown kinds", () => {
    for (const name of ["../main.js", "a/b.js", "a\\b.js", ".hidden.js", "main.wasm", "main"]) {
      expect(parseReviewPageAssetManifest({ formatVersion: 1, assets: [name] })).toBeUndefined();
    }
    expect(parseReviewPageAssetManifest({ formatVersion: 2, assets: [] })).toBeUndefined();
    expect(parseReviewPageAssetManifest(null)).toBeUndefined();
  });

  test("types scripts and styles explicitly", () => {
    expect(reviewAssetContentType("main-1.js")).toBe("text/javascript; charset=utf-8");
    expect(reviewAssetContentType("main-1.css")).toBe("text/css; charset=utf-8");
    expect(reviewAssetContentType("main-1.html")).toBeUndefined();
  });
});

describe("directory page builds", () => {
  test("serve the document and listed assets only", async () => {
    const assets = directoryReviewPageAssets(writeTestBuild())!;

    expect(await assets.document().body.text()).toContain("<!doctype html>");
    expect(await assets.asset("main-abc123.js")!.body.text()).toBe("console.log(1);");
    expect(assets.asset("main-abc123.js")!.gzip).toBe(false);
    // Present on disk but absent from the manifest: unreachable by name.
    expect(assets.asset("unlisted.js")).toBeUndefined();
    expect(assets.asset(REVIEW_PAGE_MANIFEST_NAME)).toBeUndefined();
  });

  test("are absent when the manifest is missing or invalid", () => {
    expect(directoryReviewPageAssets(join(tmpdir(), "hunk-no-such-build"))).toBeUndefined();
    expect(
      directoryReviewPageAssets(writeTestBuild({ formatVersion: 1, assets: ["../x.js"] })),
    ).toBeUndefined();
  });
});

describe("embedded page archives", () => {
  test("round-trip every file, stored gzip-compressed", async () => {
    const archive = encodeReviewPageAssetArchive(MANIFEST, FILES);
    const assets = (await archiveReviewPageAssets(new Blob([archive])))!;

    const document = assets.document();
    expect(document.gzip).toBe(true);
    expect(new TextDecoder().decode(Bun.gunzipSync(await document.body.bytes()))).toContain(
      "<!doctype html>",
    );
    const script = assets.asset("main-abc123.js")!;
    expect(new TextDecoder().decode(Bun.gunzipSync(await script.body.bytes()))).toBe(
      "console.log(1);",
    );
    expect(assets.asset("unlisted.js")).toBeUndefined();
  });

  test("refuse a missing file at build time", () => {
    const partial = new Map(FILES);
    partial.delete("main-abc123.css");
    expect(() => encodeReviewPageAssetArchive(MANIFEST, partial)).toThrow("main-abc123.css");
  });

  test("refuse a truncated or foreign archive", async () => {
    const archive = encodeReviewPageAssetArchive(MANIFEST, FILES);

    expect(await archiveReviewPageAssets(new Blob([archive.slice(0, 20)]))).toBeUndefined();
    expect(await archiveReviewPageAssets(new Blob([archive.slice(0, -4)]))).toBeUndefined();
    expect(await archiveReviewPageAssets(new Blob(["not an archive"]))).toBeUndefined();
  });
});
