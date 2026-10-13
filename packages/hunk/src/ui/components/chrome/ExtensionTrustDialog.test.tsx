import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { join } from "node:path";
import type { RepoExtensionSnapshot } from "../../../extensions/types";
import { resolveTheme } from "../../themes";
import { ExtensionTrustDialog } from "./ExtensionTrustDialog";

/** Render the exact entry inventory offered for approval, including paths outside .hunk. */
test("repo approval names captured entries, config paths, and fingerprint", async () => {
  const root = join(process.cwd(), "review-fixture");
  const snapshot: RepoExtensionSnapshot = {
    version: 1,
    repoRoot: root,
    inputs: [],
    fingerprint: "abcdef123456".repeat(6).slice(0, 64),
    entries: [".hunk/extensions/entry.ts", "src/config-entry.ts", "../outside.ts", "fourth.ts"].map(
      (path, index) => ({
        candidate: { id: `entry-${index}`, path: join(root, ...path.split("/")), origin: "repo" },
        code: "",
        digest: "",
      }),
    ),
  };
  const setup = await testRender(
    <ExtensionTrustDialog
      repoRoot={root}
      snapshot={snapshot}
      terminalHeight={24}
      terminalWidth={100}
      theme={resolveTheme("github-dark-default", "dark")}
      onTrust={() => {}}
      onDeny={() => {}}
      onClose={() => {}}
    />,
    { width: 100, height: 24 },
  );
  try {
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("config paths");
    expect(frame).toContain("entry.ts");
    expect(frame).toContain("config-entry.ts");
    expect(frame).toContain("outside.ts");
    expect(frame).toContain("+ 1 more entry");
    expect(frame).toContain("Approve all 4 entries");
    expect(frame).toContain("abcdef123456");
    expect(frame).toContain("changed code needs new approval");
    expect(frame).toContain("enter/t");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});
