import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRuntimeDir } from "../../../../../test/helpers/runtime-dir";
import { reviewPagePath } from "../reviewHttpProtocol";
import { serveSessionBrokerDaemon } from "./brokerServer";
import {
  archiveReviewPageAssets,
  directoryReviewPageAssets,
  encodeReviewPageAssetArchive,
  REVIEW_PAGE_DOCUMENT_NAME,
  REVIEW_PAGE_MANIFEST_NAME,
  type ReviewPageAssetManifestV1,
  type ReviewPageAssets,
} from "./reviewPageAssets";
import { REVIEW_PAGE_CONTENT_SECURITY_POLICY, ReviewPageServer } from "./reviewPageServer";

const ORIGIN = "http://127.0.0.1:47657";
const SCRIPT = "main-abc123.js";
const STYLESHEET = "main-abc123.css";
const DOCUMENT = `<!doctype html><link rel="stylesheet" href="/review-assets/${STYLESHEET}"><script type="module" src="/review-assets/${SCRIPT}"></script>`;
const MANIFEST: ReviewPageAssetManifestV1 = { formatVersion: 1, assets: [SCRIPT, STYLESHEET] };
const FILES = new Map<string, Uint8Array<ArrayBuffer>>([
  [REVIEW_PAGE_DOCUMENT_NAME, new TextEncoder().encode(DOCUMENT)],
  [SCRIPT, new TextEncoder().encode("console.log('page');")],
  [STYLESHEET, new TextEncoder().encode("body{margin:0}")],
]);

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Write one page build directory, plus a file the manifest does not list. */
function createTestPageDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "hunk-page-server-"));
  directories.push(directory);
  for (const [name, bytes] of FILES) {
    writeFileSync(join(directory, name), bytes);
  }
  writeFileSync(join(directory, "unlisted.js"), "secret();");
  writeFileSync(join(directory, REVIEW_PAGE_MANIFEST_NAME), JSON.stringify(MANIFEST));
  return directory;
}

/** Both ways a distribution carries the build: plain files and the gzip archive. */
const STORES: Array<[string, () => Promise<ReviewPageAssets>]> = [
  ["a build directory", async () => directoryReviewPageAssets(createTestPageDirectory())!],
  [
    "an embedded archive",
    async () =>
      (await archiveReviewPageAssets(new Blob([encodeReviewPageAssetArchive(MANIFEST, FILES)])))!,
  ],
];

/** Request one path from a page server over the given store. */
function requestTestPage(
  assets: ReviewPageAssets | undefined,
  path: string,
  init: RequestInit = {},
) {
  const server = new ReviewPageServer({ loadAssets: async () => assets });
  return server.handle(new Request(`${ORIGIN}${path}`, init));
}

/** Read a body whichever way it was encoded, the way a browser would. */
async function readTestBody(response: Response) {
  const bytes = await response.bytes();
  return new TextDecoder().decode(
    response.headers.get("content-encoding") === "gzip" ? Bun.gunzipSync(bytes) : bytes,
  );
}

for (const [label, createStore] of STORES) {
  describe(`review page server over ${label}`, () => {
    test("serves the same document, with no secret, for every session id", async () => {
      const assets = await createStore();
      const first = (await requestTestPage(assets, reviewPagePath("session-1")))!;
      const second = (await requestTestPage(assets, reviewPagePath("no-such-session")))!;

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = await readTestBody(first);
      expect(await readTestBody(second)).toBe(firstBody);
      expect(firstBody).toBe(DOCUMENT);
      // A capability is 43 base64url characters; the document must contain nothing like one.
      expect(firstBody).not.toMatch(/[A-Za-z0-9_-]{43}/);
    });

    test("sends the page policy and security headers on the document", async () => {
      const response = (await requestTestPage(await createStore(), reviewPagePath("s")))!;

      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("content-security-policy")).toBe(
        REVIEW_PAGE_CONTENT_SECURITY_POLICY,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    });

    test("serves listed assets with their type and immutable caching", async () => {
      const assets = await createStore();
      const script = (await requestTestPage(assets, `/review-assets/${SCRIPT}`))!;
      const stylesheet = (await requestTestPage(assets, `/review-assets/${STYLESHEET}`))!;

      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(script.headers.get("x-content-type-options")).toBe("nosniff");
      expect(script.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(await readTestBody(script)).toBe("console.log('page');");
      expect(stylesheet.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(await readTestBody(stylesheet)).toBe("body{margin:0}");
    });

    test("answers 404 for names the manifest does not list", async () => {
      const assets = await createStore();
      for (const path of [
        "/review-assets/unknown-000000.js",
        "/review-assets/unlisted.js",
        `/review-assets/${REVIEW_PAGE_MANIFEST_NAME}`,
        `/review-assets/${REVIEW_PAGE_DOCUMENT_NAME}`,
        "/review-assets/",
        "/review-assets",
      ]) {
        const response = (await requestTestPage(assets, path))!;
        expect(response.status).toBe(404);
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      }
    });

    test("cannot be walked out of its prefixes", async () => {
      const assets = await createStore();
      for (const path of [
        "/review-assets/..%2Fmanifest.json",
        "/review-assets/%2e%2e%2fmanifest.json",
        "/review-assets/sub/main-abc123.js",
        "/review-assets/.%2E/package.json",
        "/review-assets/main-abc123.js%00",
        "/review/session-1/../../review-assets/unlisted.js",
        "/review/session-1/extra/",
        "/review/session-1",
        "/review/a%2Fb/",
        "/review/",
      ]) {
        const response = await requestTestPage(assets, path);
        // Either declined (normalized outside the prefixes) or refused; never a file.
        expect(response === undefined || response.status === 404).toBe(true);
      }
    });

    test("answers HEAD with headers and no body", async () => {
      const response = (await requestTestPage(await createStore(), `/review-assets/${SCRIPT}`, {
        method: "HEAD",
      }))!;

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
      expect((await response.bytes()).byteLength).toBe(0);
    });

    test("refuses methods other than GET and HEAD", async () => {
      const assets = await createStore();
      for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
        for (const path of [reviewPagePath("s"), `/review-assets/${SCRIPT}`]) {
          const response = (await requestTestPage(assets, path, { method }))!;
          expect(response.status).toBe(405);
          expect(response.headers.get("allow")).toBe("GET, HEAD");
        }
      }
    });
  });
}

describe("review page server encoding and availability", () => {
  test("serves archived files compressed only to clients that accept gzip", async () => {
    const assets = await STORES[1]![1]();
    const compressed = (await requestTestPage(assets, `/review-assets/${SCRIPT}`, {
      headers: { "accept-encoding": "gzip, deflate, br" },
    }))!;
    const plain = (await requestTestPage(assets, `/review-assets/${SCRIPT}`, {
      headers: { "accept-encoding": "identity, gzip;q=0" },
    }))!;

    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(compressed.headers.get("vary")).toBe("accept-encoding");
    expect(plain.headers.has("content-encoding")).toBe(false);
    expect(await plain.text()).toBe("console.log('page');");
  });

  test("answers 503 when this build carries no page", async () => {
    const response = (await requestTestPage(undefined, reviewPagePath("s")))!;

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  test("declines every path outside its prefixes", async () => {
    const assets = await STORES[0]![1]();
    for (const path of [
      "/health",
      "/review-api/session-1/publication",
      "/reviewer/",
      "/review-assetsx/main.js",
      "/session-api",
    ]) {
      expect(await requestTestPage(assets, path)).toBeUndefined();
    }
  });
});

describe("review page inside the daemon", () => {
  const originalPort = process.env.HUNK_MCP_PORT;
  const originalHost = process.env.HUNK_MCP_HOST;
  const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
  const runtime = createTestRuntimeDir("hunk-page-daemon-runtime-");
  let stop: (() => void) | undefined;
  let origin = "";

  beforeAll(async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", () => resolve()));
    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => listener.close(() => resolve()));

    process.env.XDG_RUNTIME_DIR = runtime.path;
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);
    const assets = directoryReviewPageAssets(createTestPageDirectory());
    const server = await serveSessionBrokerDaemon({ loadReviewPageAssets: async () => assets });
    stop = () => server.stop(true);
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    stop?.();
    for (const [key, value] of [
      ["HUNK_MCP_PORT", originalPort],
      ["HUNK_MCP_HOST", originalHost],
      ["XDG_RUNTIME_DIR", originalRuntimeDir],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await runtime.cleanup();
  });

  test("serves the page on the daemon's origin", async () => {
    const response = await fetch(`${origin}${reviewPagePath("session-1")}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(DOCUMENT);
    expect(response.headers.get("content-security-policy")).toBe(
      REVIEW_PAGE_CONTENT_SECURITY_POLICY,
    );
  });

  test("runs the daemon's Host and Origin checks before the page", async () => {
    const wrongHost = await fetch(`${origin}${reviewPagePath("session-1")}`, {
      headers: { host: "evil.example" },
    });
    const wrongOrigin = await fetch(`${origin}/review-assets/${SCRIPT}`, {
      headers: { origin: "http://evil.example" },
    });

    expect(wrongHost.status).toBe(403);
    expect(wrongOrigin.status).toBe(403);
  });

  test("leaves the review API and the daemon's own routes unchanged", async () => {
    const api = await fetch(`${origin}/review-api/session-1/publication`);
    const health = await fetch(`${origin}/health`);
    const unknown = await fetch(`${origin}/not-a-route`);

    expect(api.status).toBe(401);
    expect(health.status).toBe(200);
    expect(unknown.status).toBe(404);
  });
});
