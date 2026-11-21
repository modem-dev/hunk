import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

setDefaultTimeout(25_000);

const REACT_EXTENSION = `import { useState } from "react";
export default function (hunk) {
  hunk.registerPane({
    id: "hello", placement: "top", height: { preferred: 2, min: 2, max: 2 }, defaultOpen: true,
    component: () => {
      const [message] = useState("REACT_EXTENSION_RENDERED");
      return <text>{message}</text>;
    },
  });
}
`;

const PLAIN_EXTENSION = `export default function (hunk) {
  hunk.on("startup", (_event, ctx) => ctx.statusLine.set({
    id: "proof", spans: [{ text: "PLAIN_EXTENSION_LOADED" }],
  }));
}
`;

/** Commit a small diff without relying on the user's Git identity or repository. */
function createTestReviewFixture(repo: string) {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
  };
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "a.ts"), "export const value = 1;\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  writeFileSync(join(repo, "a.ts"), "export const value = 2;\n");
}

for (const mode of ["unified", "split"] as const) {
  for (const kind of ["copied-react", "symlink-react", "symlink-plain"] as const) {
    test(`global extension loads: ${kind} (${mode})`, async () => {
      const root = mkdtempSync(join(tmpdir(), "hunk-extension-file-symlink-"));
      const harness = createPtyHarness();
      let session: Awaited<ReturnType<typeof harness.launchHunk>> | undefined;
      try {
        const repo = join(root, "repo");
        const config = join(root, "config");
        const extensionDir = join(config, "hunk", "extensions");
        const outside = join(root, "elsewhere");
        for (const dir of [repo, extensionDir, outside]) mkdirSync(dir, { recursive: true });
        createTestReviewFixture(repo);
        const source = kind === "symlink-plain" ? PLAIN_EXTENSION : REACT_EXTENSION;
        const name = kind === "symlink-plain" ? "hello.ts" : "hello.tsx";
        const target = join(outside, name);
        const entry = join(extensionDir, name);
        writeFileSync(target, source);
        if (kind === "copied-react") writeFileSync(entry, source);
        else symlinkSync(target, entry, "file");

        session = await harness.launchHunk({
          args: ["diff", "--mode", mode, "--theme", "github-dark-default"],
          cwd: repo,
          cols: 160,
          rows: 35,
          env: { XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(root, "state") },
        });
        const marker =
          kind === "symlink-plain" ? "PLAIN_EXTENSION_LOADED" : "REACT_EXTENSION_RENDERED";
        const text = await session.waitForText(marker, { timeout: 12_000 });

        expect(text).toContain(marker);
        expect(text).not.toMatch(/failed to load/i);
      } finally {
        session?.close();
        harness.cleanup();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
