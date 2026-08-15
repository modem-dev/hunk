/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatReviewAddress } from "../core/review/address";
import { projectReviewDocument } from "../core/review/document";
import { reviewResourceId } from "../core/review/resources";
import type { ReviewFileV1 } from "../core/review/types";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import { reviewErrorMessage } from "../session/reviewErrorCatalog";
import { reviewHttpFailure } from "../session/reviewHttpProtocol";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../session/reviewProtocol";
import type { ReviewApiClient, ReviewEventHandlers } from "./reviewApiClient";
import { ReviewApp } from "./ReviewApp";
import { ReviewMirror, type ReviewMirrorSource } from "./reviewMirror";

const SESSION_ID = "session-1";
const GENERATION = "generation:p1:0";
const BASE = `${Array.from({ length: 12 }, (_unused, index) => `line ${index + 1}`).join("\n")}\n`;

/** Two files a review would publish, in this order. */
function documentFiles(): ReviewFileV1[] {
  return projectReviewDocument(
    [
      createTestDiffFile({
        id: "alpha",
        path: "src/alpha.ts",
        before: BASE,
        after: BASE.replace("line 4", "line 4 changed"),
        context: 3,
      }),
      createTestDiffFile({
        id: "beta",
        path: "src/beta.ts",
        before: BASE,
        after: BASE.replace("line 9", "line 9 changed"),
        context: 3,
      }),
    ],
    { sourceLabel: "/repo" },
  ).files;
}

/** A mirror driven through its real transport seam until it has settled. */
async function settledMirror(files: ReviewFileV1[], serve: ReviewMirrorSource["readResource"]) {
  let handlers: ReviewEventHandlers | undefined;
  const source: ReviewMirrorSource = {
    readResource: serve,
    streamEvents(next) {
      handlers = next;
      return new Promise<void>(() => undefined);
    },
  };
  const mirror = new ReviewMirror(source, {
    timers: { setTimeout: () => 1, clearTimeout: () => undefined },
  });
  mirror.start();
  handlers!.onPublication({
    protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
    sessionId: SESSION_ID,
    publication: { generation: GENERATION, stateRevision: 1 },
    catalog: {
      generation: GENERATION,
      fileKeysByRuntimeId: Object.fromEntries(files.map((file) => [file.runtimeId, file.key])),
      resources: files.map((file) => ({
        id: reviewResourceId({ kind: "canonical-file", fileKey: file.key }),
        generation: GENERATION,
        fileKey: file.key,
        kind: "canonical-file" as const,
        contentType: "application/vnd.hunk.review-file+json; charset=utf-8" as const,
      })),
    },
  });
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
  return { mirror, handlers: handlers! };
}

/** Serve each file's canonical form, as the surface would. */
function serveFiles(files: ReviewFileV1[]): ReviewMirrorSource["readResource"] {
  const encoder = new TextEncoder();
  return async (descriptor) => {
    const file = files.find(
      (candidate) =>
        reviewResourceId({ kind: "canonical-file", fileKey: candidate.key }) === descriptor.id,
    );
    return file
      ? { ok: true, value: encoder.encode(JSON.stringify(file)) }
      : { ok: false, code: "unknown-resource", message: "not in this test" };
  };
}

/** The client the page would fetch source with; nothing static-rendered reaches it. */
const UNUSED_CLIENT = {} as ReviewApiClient;

describe("ReviewApp", () => {
  test("lists every file in review order, linking to its place in the stream", async () => {
    const files = documentFiles();
    const { mirror } = await settledMirror(files, serveFiles(files));

    const markup = renderToStaticMarkup(<ReviewApp mirror={mirror} client={UNUSED_CLIENT} />);

    const [first, second] = files;
    expect(markup).toContain(
      `href="#${formatReviewAddress({ kind: "file", fileKey: first!.key })}"`,
    );
    expect(markup.indexOf("src/alpha.ts")).toBeLessThan(markup.indexOf("src/beta.ts"));
    expect(markup).toContain(formatReviewAddress({ kind: "file", fileKey: second!.key }));
  });

  test("says nothing about a review it has not loaded yet", () => {
    const idle = new ReviewMirror(
      {
        readResource: async () => ({ ok: false, code: "unknown-resource", message: "idle" }),
        streamEvents: () => new Promise<void>(() => undefined),
      },
      { timers: { setTimeout: () => 1, clearTimeout: () => undefined } },
    );

    const markup = renderToStaticMarkup(<ReviewApp mirror={idle} client={UNUSED_CLIENT} />);

    expect(markup).toContain('data-status="idle"');
    expect(markup).not.toContain("review-file-list");
  });

  test("shows a failure in the words the mirror was given, not its own", async () => {
    const files = documentFiles();
    const failure = reviewErrorMessage("resource-unavailable");
    const { mirror } = await settledMirror(files, async () => ({
      ok: false,
      code: "resource-unavailable",
      message: failure,
    }));

    const markup = renderToStaticMarkup(<ReviewApp mirror={mirror} client={UNUSED_CLIENT} />);

    expect(markup).toContain('data-status="failed"');
    expect(markup).toContain(failure);
  });

  test("keeps the diff on screen while the dropped stream is reconnecting", async () => {
    const files = documentFiles();
    const { mirror, handlers } = await settledMirror(files, serveFiles(files));

    handlers.onError?.(reviewHttpFailure("resource-unavailable"));
    const markup = renderToStaticMarkup(<ReviewApp mirror={mirror} client={UNUSED_CLIENT} />);

    expect(markup).toContain('data-status="reconnecting"');
    expect(markup).toContain("Reconnecting to the review…");
    expect(markup).toContain("src/alpha.ts");
  });
});
