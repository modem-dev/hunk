import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveReviewPageAssets,
  createSourceReviewPageLoader,
  currentDirectoryReviewPageAssets,
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

describe("a build directory under a running daemon", () => {
  test("serves a rebuild's names once the manifest changes", async () => {
    const directory = writeTestBuild();
    expect(currentDirectoryReviewPageAssets(directory)!.asset("main-abc123.js")).toBeDefined();

    // A rebuild replaces the hashed names and the manifest that lists them.
    unlinkSync(join(directory, "main-abc123.js"));
    writeFileSync(join(directory, "main-def456.js"), "console.log(2);");
    writeFileSync(
      join(directory, REVIEW_PAGE_MANIFEST_NAME),
      JSON.stringify({ formatVersion: 1, assets: ["main-def456.js", "main-abc123.css"] }),
    );

    const rebuilt = currentDirectoryReviewPageAssets(directory)!;
    expect(rebuilt.asset("main-abc123.js")).toBeUndefined();
    expect(await rebuilt.asset("main-def456.js")!.body.text()).toBe("console.log(2);");
  });

  test("answers from the current manifest even through an earlier lookup", async () => {
    const directory = writeTestBuild();
    const cached = currentDirectoryReviewPageAssets(directory)!;
    // The new build's file and manifest land after a lookup already held the old manifest.
    writeFileSync(join(directory, "main-def456.js"), "console.log(3);");
    writeFileSync(
      join(directory, REVIEW_PAGE_MANIFEST_NAME),
      JSON.stringify({ formatVersion: 1, assets: ["main-def456.js"] }),
    );
    unlinkSync(join(directory, "main-abc123.js"));

    expect(cached.asset("main-abc123.js")).toBeUndefined();
    expect(await cached.asset("main-def456.js")!.body.text()).toBe("console.log(3);");
  });
});

describe("a source checkout's on-demand build", () => {
  test("builds at most once per daemon and remembers a failure", async () => {
    let builds = 0;
    const load = createSourceReviewPageLoader(
      async () => {
        builds += 1;
        return false;
      },
      () => undefined,
    );
    expect(await Promise.all([load(), load()])).toEqual([undefined, undefined]);
    expect(await load()).toBeUndefined();
    expect(builds).toBe(1);
  });

  test("serves a build that appears later without building again", async () => {
    const directory = writeTestBuild();
    let present = false;
    let builds = 0;
    const load = createSourceReviewPageLoader(
      async () => {
        builds += 1;
        return true;
      },
      () => (present ? currentDirectoryReviewPageAssets(directory) : undefined),
    );
    expect(await load()).toBeUndefined();
    present = true;
    expect(await load()).toBeDefined();
    expect(builds).toBe(1);
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
