import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstallRecords, resolveInstallRecordsPath, writeInstallRecords } from "./records";
import { npmInstallName } from "./source";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Create isolated record storage without running an installer. */
function createRecordsTestRoot() {
  const root = mkdtempSync(join(tmpdir(), "hunk-records-test-"));
  roots.push(root);
  return root;
}

const timestamps = {
  installedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("reads pre-npm Git records and round-trips mixed backend records", () => {
  const root = createRecordsTestRoot();
  const git = {
    source: "acme/guide@v1",
    cloneUrl: "https://github.com/acme/guide",
    ref: "v1",
    commit: "abc",
    ...timestamps,
  };
  writeFileSync(resolveInstallRecordsPath(root), JSON.stringify({ installs: { guide: git } }));
  expect(readInstallRecords(root)).toEqual({ guide: { kind: "git", ...git } });
  const name = npmInstallName("@acme/guide");
  const npm = {
    kind: "npm" as const,
    source: "npm:@acme/guide@^1.0.0",
    packageName: "@acme/guide",
    selector: "^1.0.0",
    version: "1.1.0",
    ...timestamps,
  };
  writeInstallRecords(root, { ...readInstallRecords(root), [name]: npm });
  expect(readInstallRecords(root)).toEqual({ guide: { kind: "git", ...git }, [name]: npm });
});

test("ignores unknown, malformed and path-unsafe records rather than operating on their directories", () => {
  const root = createRecordsTestRoot();
  const valid = {
    kind: "npm",
    source: "npm:@acme/guide",
    packageName: "@acme/guide",
    version: "1.0.0",
    ...timestamps,
  };
  writeFileSync(
    resolveInstallRecordsPath(root),
    JSON.stringify({
      installs: {
        "../escape": valid,
        unknown: { ...valid, kind: "other" },
        mismatch: { ...valid, packageName: "../../outside" },
        selector: { ...valid, selector: "next" },
        malformed: { ...valid, version: undefined },
        unsupported: { ...valid, source: "npm:@acme/guide@file:../outside" },
      },
    }),
  );
  expect(readInstallRecords(root)).toEqual({});
});
