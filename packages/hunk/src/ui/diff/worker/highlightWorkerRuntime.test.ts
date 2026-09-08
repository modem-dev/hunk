import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../../../../test/helpers/diff-helpers";
import {
  compactHighlightedDocumentRunsForLine,
  validateCompactHighlightedDiff,
  validateCompactHighlightedDocument,
} from "./highlightCompact";
import { HighlightWorkerCache } from "./highlightWorkerCache";
import { highlightWorkerCacheKey } from "./highlightWorkerIdentity";
import {
  HIGHLIGHT_WORKER_PROTOCOL_VERSION,
  type HighlightWorkerDiffRequest,
  type HighlightWorkerDocumentRequest,
} from "./highlightWorkerProtocol";
import { processHighlightWorkerRequest } from "./highlightWorkerRuntime";

/** Build one complete TypeScript document request with multiline lexical state. */
function documentRequest(
  overrides: Partial<HighlightWorkerDocumentRequest> = {},
): HighlightWorkerDocumentRequest {
  return {
    version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
    id: 1,
    kind: "document",
    appearance: "dark",
    language: "typescript",
    path: "example.ts",
    text: "const live = true;\n/* comment starts\nconst looksLikeCode = false;\ncomment ends */\n",
    theme: "pierre-dark",
    ...overrides,
  };
}

/** Build one existing diff request to guard its worker behavior. */
function diffRequest(): HighlightWorkerDiffRequest {
  return {
    version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
    id: 2,
    kind: "diff",
    aliasContext: false,
    appearance: "dark",
    language: "typescript",
    metadata: createTestDiffFile().metadata,
    theme: "pierre-dark",
  };
}

describe("highlight worker runtime", () => {
  test("highlights complete documents with multiline lexical context", async () => {
    const response = await processHighlightWorkerRequest(
      documentRequest(),
      new HighlightWorkerCache(),
    );

    expect(response).toMatchObject({
      version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      id: 1,
      kind: "document",
      ok: true,
    });
    if (!response.ok || response.kind !== "document") throw new Error("Expected document result");
    validateCompactHighlightedDocument(response.code, [18, 17, 28, 15]);

    const ordinaryCode = compactHighlightedDocumentRunsForLine(response.code, 0);
    const commentCode = compactHighlightedDocumentRunsForLine(response.code, 2);
    expect(ordinaryCode.length).toBeGreaterThan(1);
    expect(commentCode).toHaveLength(1);
    expect(commentCode[0]?.fg).toBe(compactHighlightedDocumentRunsForLine(response.code, 1)[0]?.fg);
    expect(response.code.document.flags.every((flag) => flag === 0)).toBe(true);
    expect(JSON.stringify(response.code)).not.toContain("looksLikeCode");
  });

  test("preserves existing diff jobs through the shared protocol and cache", async () => {
    const response = await processHighlightWorkerRequest(diffRequest(), new HighlightWorkerCache());
    expect(response).toMatchObject({ kind: "diff", ok: true, id: 2 });
    if (!response.ok || response.kind !== "diff") throw new Error("Expected diff result");
    validateCompactHighlightedDiff(response.code);
    expect(response.code.deletion.lineOffsets.length).toBeGreaterThan(0);
    expect(response.code.addition.lineOffsets.length).toBeGreaterThan(0);
  });

  test("returns protocol failures for wrong versions and malformed document jobs", async () => {
    const cache = new HighlightWorkerCache();
    const wrongVersion = await processHighlightWorkerRequest(
      { ...documentRequest(), version: 3 },
      cache,
    );
    expect(wrongVersion).toMatchObject({
      version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      id: 1,
      kind: "document",
      ok: false,
    });
    if (wrongVersion.ok) throw new Error("Expected failure");
    expect(wrongVersion.message).toContain("Unsupported");

    const malformed = await processHighlightWorkerRequest(
      { ...documentRequest(), text: "not\rnormalized" },
      cache,
    );
    expect(malformed.ok).toBe(false);
    if (malformed.ok) throw new Error("Expected failure");
    expect(malformed.message).toContain("normalized LF");
  });

  test("returns independent cached clones and leaves oversized payloads uncached", async () => {
    const request = documentRequest({ text: "const answer = 42;\n" });
    const cache = new HighlightWorkerCache();
    const first = await processHighlightWorkerRequest(request, cache);
    const second = await processHighlightWorkerRequest({ ...request, id: 9 }, cache);
    if (!first.ok || first.kind !== "document" || !second.ok || second.kind !== "document") {
      throw new Error("Expected cached document results");
    }
    expect(first.code.document.starts).not.toBe(second.code.document.starts);
    expect(first.code.document.starts).toEqual(second.code.document.starts);

    const tinyCache = new HighlightWorkerCache(1);
    const uncached = await processHighlightWorkerRequest(request, tinyCache);
    expect(uncached.ok).toBe(true);
    const { id: _id, version: _version, ...identity } = request;
    expect(tinyCache.get(highlightWorkerCacheKey(identity))).toBeUndefined();
    expect(tinyCache.getCachedBytes()).toBe(0);
  });
});
