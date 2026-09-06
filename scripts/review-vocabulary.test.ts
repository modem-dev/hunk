/**
 * Rung 5 of the per-phase seam ladder: vocabulary and constant derivation.
 *
 * Import gates prove a module *may* use a shared definition; the conformance harness
 * proves consumers agree on answers. Neither catches the failure this suite exists for:
 * a wire schema that quietly stops covering the semantics it is supposed to carry, or
 * re-states a bound that already exists somewhere else
 * (`docs/browser-review-rebuild.md` § "Per-phase seam verification", rung 5).
 *
 * Two mechanical claims:
 *
 * - The wire action vocabulary **is** the intent vocabulary, so an intent added in a later
 *   phase becomes wire-reachable automatically and one deliberately withheld has to be
 *   subtracted by name and justified (`browser-review-seam-audit.md`, B12).
 * - Coupled constants are imported, not re-declared: no session module re-declares a name
 *   the shared review model already exports, no digest check is written as an inline
 *   pattern beside the shared validator, and the transport bound the browser-safe protocol
 *   deliberately does not import still accommodates it (D5).
 *
 * It lives in `scripts/` beside the boundary gate because it is the same kind of thing —
 * a mechanical check over the source tree — and is kept in its own file so the boundary
 * gate's tombstone and debt lists stay easy to audit.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { MAX_WS_MESSAGE_BYTES } from "@hunk/session-broker-core";
import { REVIEW_INTENT_TYPES } from "../packages/hunk/src/core/review/intents";
import { REVIEW_RESOURCE_CHUNK_BYTES } from "../packages/hunk/src/core/review/resources";
import {
  MAX_REVIEW_EVENT_CHUNKS,
  MAX_REVIEW_EVENT_PAYLOAD_BYTES,
  REVIEW_EVENT_CHUNK_BYTES,
} from "../packages/hunk/src/session/reviewEventProtocol";
import {
  HUNK_REVIEW_ACTION_TYPES,
  MAX_HUNK_REVIEW_ENVELOPE_BYTES,
  parseHunkReviewAction,
} from "../packages/hunk/src/session/reviewProtocol";

const REPO_ROOT = resolve(import.meta.dir, "..");
const HUNK_SOURCE_ROOT = join(REPO_ROOT, "packages", "hunk", "src");
const REVIEW_MODEL_ROOT = join(HUNK_SOURCE_ROOT, "core", "review");
const SESSION_ROOT = join(HUNK_SOURCE_ROOT, "session");
const PRODUCER_ROOT = join(HUNK_SOURCE_ROOT, "app");

/** Every production TypeScript file below one directory. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Repo-relative path with forward slashes, for stable assertions on every platform. */
function repoPath(path: string) {
  return path
    .slice(REPO_ROOT.length + 1)
    .split(sep)
    .join("/");
}

/** Every `export const NAME` one file declares. */
function exportedConstants(path: string) {
  return [...readFileSync(path, "utf8").matchAll(/export const ([A-Z][A-Z0-9_]*)\b/g)].map(
    (match) => match[1]!,
  );
}

describe("review wire vocabulary derivation", () => {
  // Withholding an intent would land here as a named subtraction from the intent
  // vocabulary; until one is justified, a type missing from the wire is a silent drop.
  test("is the intent vocabulary, whole and once each", () => {
    const actionTypes = [...HUNK_REVIEW_ACTION_TYPES];
    expect(actionTypes).toEqual([...REVIEW_INTENT_TYPES]);
    expect(new Set(actionTypes).size).toBe(actionTypes.length);
  });

  // A type in the vocabulary with no parser would fail open: the action would be reported
  // as unknown rather than validated. Probing each type with a field no intent has proves
  // a parser really ran — an unrouted type would answer `unsupported` instead.
  test("routes every action in the vocabulary to a parser", () => {
    for (const type of HUNK_REVIEW_ACTION_TYPES) {
      expect(parseHunkReviewAction({ type, unexpectedField: 1 })).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  test("reports a type outside the vocabulary as unsupported", () => {
    expect(parseHunkReviewAction({ type: "notes/archive-user", noteId: "n" })).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });
});

describe("review constant derivation", () => {
  // A session module that re-declares a shared name is the drift the audit found: two
  // constants with one name, changed independently.
  test("no session module re-declares a constant the review model exports", () => {
    const modelConstants = new Set(sourceFiles(REVIEW_MODEL_ROOT).flatMap(exportedConstants));
    const collisions = sourceFiles(SESSION_ROOT).flatMap((path) =>
      exportedConstants(path)
        .filter((name) => modelConstants.has(name))
        .map((name) => `${repoPath(path)} -> ${name}`),
    );

    expect(collisions).toEqual([]);
  });

  // The canonical digest check lives in `core/review/validation.ts`; five inline patterns
  // with differing case sensitivity are what let a writer and a reader disagree about
  // whether two digests matched. The producer tier is scanned too, because it is the side
  // that computes the digests the other tiers compare.
  test("no module writes its own SHA-256 digest pattern", () => {
    const pattern = /\{\s*64\s*\}/;
    const offenders = [
      ...sourceFiles(SESSION_ROOT),
      ...sourceFiles(REVIEW_MODEL_ROOT),
      ...sourceFiles(PRODUCER_ROOT),
    ]
      .filter((path) => repoPath(path) !== "packages/hunk/src/core/review/validation.ts")
      .filter((path) => pattern.test(readFileSync(path, "utf8")))
      .map(repoPath);

    expect(offenders).toEqual([]);
  });

  // The wire protocol stays browser-safe by not importing the broker package, so the one
  // coupling it cannot express as an import is asserted here instead: whatever frame the
  // session transport carries must still fit a complete review envelope.
  test("the session transport can carry a complete review envelope", () => {
    expect(MAX_WS_MESSAGE_BYTES).toBeGreaterThanOrEqual(MAX_HUNK_REVIEW_ENVELOPE_BYTES);
  });

  // C4: the event stream's bounds are the protocol's and the resource path's, arithmetic
  // apart. The prototype chose them separately on each end and they were compatible only
  // by luck, so the check is that they are still the same numbers rather than that they
  // are still large enough.
  test("the event stream derives its bounds rather than choosing them", () => {
    expect(MAX_REVIEW_EVENT_PAYLOAD_BYTES).toBe(MAX_HUNK_REVIEW_ENVELOPE_BYTES);
    expect(REVIEW_EVENT_CHUNK_BYTES).toBe(REVIEW_RESOURCE_CHUNK_BYTES);
    expect(MAX_REVIEW_EVENT_CHUNKS).toBe(
      Math.ceil(MAX_HUNK_REVIEW_ENVELOPE_BYTES / REVIEW_RESOURCE_CHUNK_BYTES),
    );
  });
});
