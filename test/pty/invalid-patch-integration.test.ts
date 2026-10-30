import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

test("invalid patch files report failure and exit even after probing terminal colors", async () => {
  const fixture = harness.createSidebarJumpRepoFixture();
  const patch = join(fixture.dir, "invalid.patch");
  writeFileSync(patch, "not a patch\n");
  const command = harness.buildHunkCommand(["patch", patch, "--no-extensions"]);
  const session = await harness.launchShellCommand({
    command: `${command}; result=$?; printf '\\nPATCH_EXIT:%s\\n' "$result"`,
    cwd: fixture.dir,
    cols: 120,
    rows: 24,
  });

  try {
    const frame = await session.waitForText(/PATCH_EXIT:1/, { timeout: 5_000 });
    expect(frame).toContain("No recognizable file changes in patch input");
    expect(frame).not.toContain("No files match");
    expect(session.getRawOutput()).not.toContain("\u001b[?1049h");
  } finally {
    session.close();
  }
});
