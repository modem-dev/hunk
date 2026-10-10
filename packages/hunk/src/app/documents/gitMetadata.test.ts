import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { directoryStatusMarkers } from "./gitMetadata";

describe("directory status markers", () => {
  test("groups nested changes into immediate children and skips rename source records", () => {
    const repository = join(tmpdir(), "hunk-status-test");
    const key = join(repository, "selected");
    const markers = directoryStatusMarkers(
      repository,
      key,
      "R  selected/new name.ts\0selected/old name.ts\0 M selected/nested/file.ts\0?? selected/untracked.ts\0 M elsewhere/file.ts\0\0",
    );
    expect([...markers]).toEqual([
      [join(key, "new name.ts"), "R"],
      [join(key, "nested"), "M"],
      [join(key, "untracked.ts"), "?"],
    ]);
    expect(markers.has(join(key, "old name.ts"))).toBe(false);
  });

  test("omits status when metadata is unavailable", () => {
    const repository = join(tmpdir(), "hunk-status-test");
    expect(directoryStatusMarkers(repository, repository, null).size).toBe(0);
  });
});
