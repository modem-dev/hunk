import { describe, expect, test } from "bun:test";
import { measureRetainedSessionBytes } from "@hunk/session-broker-core";
import {
  createTestSessionRegistration,
  createTestSessionReviewFile,
  createTestSessionSnapshot,
} from "../../../../../test/helpers/session-daemon-fixtures";
import type { ReviewResourceCatalog } from "../reviewProtocol";
import {
  assessSessionRegistration,
  describeOversizedSessionRegistration,
  HUNK_SESSION_REGISTRATION_LIMITS,
} from "./registrationAdmission";

/** Build a registration listing `count` one-hunk files. */
function createTestRegistrationWithFiles(count: number, catalog?: ReviewResourceCatalog) {
  return createTestSessionRegistration({
    files: Array.from({ length: count }, (_, index) =>
      createTestSessionReviewFile({ id: `file-${index}`, path: `src/file-${index}.ts` }),
    ),
    ...(catalog ? { info: { reviewCatalog: catalog } } : {}),
  });
}

/** Build a catalog that declares `count` resources; only its size matters here. */
function createTestCatalogWithResources(count: number): ReviewResourceCatalog {
  return {
    generation: "generation:test:0",
    fileKeysByRuntimeId: {},
    resources: Array.from({ length: count }, (_, index) => ({
      generation: "generation:test:0",
      fileKey: `file:${index}`,
      id: `resource:patch:file:${index}`,
      kind: "patch",
      contentType: "text/x-diff; charset=utf-8",
    })),
  };
}

describe("assessSessionRegistration", () => {
  test("admits a review within every per-session bound", () => {
    expect(
      assessSessionRegistration(createTestRegistrationWithFiles(3), createTestSessionSnapshot()),
    ).toEqual({ ok: true });
  });

  test("refuses more files than the daemon lists, estimating how many it would hold", () => {
    const admission = assessSessionRegistration(
      createTestRegistrationWithFiles(12),
      createTestSessionSnapshot(),
      { ...HUNK_SESSION_REGISTRATION_LIMITS, maxFiles: 4 },
    );

    expect(admission).toEqual({ ok: false, fileCount: 12, estimatedMaxFiles: 4 });
  });

  test("refuses the daemon's own file limit with its default bounds", () => {
    const fileCount = HUNK_SESSION_REGISTRATION_LIMITS.maxFiles + 1;
    const admission = assessSessionRegistration(
      createTestRegistrationWithFiles(fileCount),
      createTestSessionSnapshot(),
    );

    expect(admission.ok).toBe(false);
    expect(admission).toMatchObject({ fileCount });
  });

  test("refuses a resource catalog larger than the daemon parses", () => {
    const admission = assessSessionRegistration(
      createTestRegistrationWithFiles(2, createTestCatalogWithResources(10)),
      createTestSessionSnapshot(),
      { ...HUNK_SESSION_REGISTRATION_LIMITS, maxCatalogResources: 5 },
    );

    expect(admission).toEqual({ ok: false, fileCount: 2, estimatedMaxFiles: 1 });
  });

  test("refuses a registration over the bytes the daemon retains per session", () => {
    const registration = createTestRegistrationWithFiles(40);
    const snapshot = createTestSessionSnapshot();
    const retained = measureRetainedSessionBytes(registration, snapshot);

    expect(
      assessSessionRegistration(registration, snapshot, {
        ...HUNK_SESSION_REGISTRATION_LIMITS,
        maxRetainedBytes: retained,
      }),
    ).toEqual({ ok: true });
    const admission = assessSessionRegistration(registration, snapshot, {
      ...HUNK_SESSION_REGISTRATION_LIMITS,
      maxRetainedBytes: Math.floor(retained / 2),
    });
    expect(admission.ok).toBe(false);
    // Per-file bytes dominate, so half the budget holds a little under half the files.
    expect(admission).toMatchObject({ fileCount: 40 });
    expect((admission as { estimatedMaxFiles: number }).estimatedMaxFiles).toBeLessThanOrEqual(20);
    expect((admission as { estimatedMaxFiles: number }).estimatedMaxFiles).toBeGreaterThan(10);
  });

  test("refuses a register message larger than one daemon frame", () => {
    const admission = assessSessionRegistration(
      createTestRegistrationWithFiles(5),
      createTestSessionSnapshot(),
      { ...HUNK_SESSION_REGISTRATION_LIMITS, maxMessageBytes: 100 },
    );

    expect(admission).toMatchObject({ ok: false, fileCount: 5 });
  });
});

describe("describeOversizedSessionRegistration", () => {
  test("names the file count, a rounded estimate, and the pathspec remedy", () => {
    expect(
      describeOversizedSessionRegistration({
        ok: false,
        fileCount: 6000,
        estimatedMaxFiles: 2300,
      }),
    ).toBe(
      "This review has 6,000 files, more than the session daemon can hold (about 2,300 files like these). Narrow it to fewer files with `-- <pathspec>`.",
    );
  });

  test("rounds an estimate down to two significant digits", () => {
    const admission = assessSessionRegistration(
      createTestRegistrationWithFiles(6000),
      createTestSessionSnapshot(),
      { ...HUNK_SESSION_REGISTRATION_LIMITS, maxFiles: 2357 },
    );

    expect(admission).toEqual({ ok: false, fileCount: 6000, estimatedMaxFiles: 2300 });
  });

  test("omits an estimate of no files", () => {
    expect(
      describeOversizedSessionRegistration({ ok: false, fileCount: 1, estimatedMaxFiles: 0 }),
    ).toBe(
      "This review has 1 file, more than the session daemon can hold. Narrow it to fewer files with `-- <pathspec>`.",
    );
  });
});
