import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserReviewNote } from "../ui/hooks/useReviewController";
import { readUserNotes, userNotesWriteWarning, writeUserNotes } from "./userNotesStore";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function note(id: string, summary: string): UserReviewNote {
  return {
    id,
    source: "user",
    filePath: "src/foo.ts",
    hunkIndex: 0,
    side: "new",
    line: 1,
    summary,
    author: "user",
    editable: true,
  } as UserReviewNote;
}

describe("userNotesStore", () => {
  test("writeUserNotes round-trips through readUserNotes, creating missing dirs", () => {
    const root = createTempDir("hunk-notes-");
    const path = join(root, ".hunk", "notes.json");
    const map = { "repo:0:src/foo.ts": [note("user:1", "first"), note("user:2", "second")] };

    writeUserNotes(path, map);

    expect(readUserNotes(path)).toEqual(map);
  });

  test("readUserNotes tolerates a missing or malformed sidecar", () => {
    const root = createTempDir("hunk-notes-");
    expect(readUserNotes(join(root, "absent.json"))).toEqual({});

    const malformed = join(root, "bad.json");
    writeFileSync(malformed, "{ not json");
    expect(readUserNotes(malformed)).toEqual({});
  });

  test("readUserNotes drops entries that are not plausible note arrays", () => {
    const root = createTempDir("hunk-notes-");
    const path = join(root, "notes.json");
    writeFileSync(path, JSON.stringify({ good: [note("user:1", "ok")], bad: [{ nope: true }] }));

    expect(Object.keys(readUserNotes(path))).toEqual(["good"]);
  });

  describe("userNotesWriteWarning", () => {
    test("no warning when the sidecar is missing but an ancestor is writable", () => {
      const root = createTempDir("hunk-notes-");
      expect(userNotesWriteWarning(join(root, ".hunk", "notes.json"))).toBeUndefined();
    });

    test("no warning when the sidecar already exists and is writable (prior review)", () => {
      const root = createTempDir("hunk-notes-");
      const path = join(root, "notes.json");
      writeUserNotes(path, { "repo:0:src/foo.ts": [note("user:1", "prior")] });

      expect(userNotesWriteWarning(path)).toBeUndefined();
    });

    test("warns when an existing sidecar is read-only", () => {
      const root = createTempDir("hunk-notes-");
      const path = join(root, "notes.json");
      writeFileSync(path, "{}");
      chmodSync(path, 0o444);

      const warning = userNotesWriteWarning(path);
      expect(warning).toContain(path);
      expect(warning).toContain("not be saved");
    });
  });
});
