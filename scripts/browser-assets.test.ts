import { describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EMBEDDED_BROWSER_ASSETS } from "../src/browser/generated/assets";
import {
  assertBrowserAssetsCurrent,
  assertBrowserBundleCurrent,
  generateBrowserAssets,
  renderBrowserAssetModule,
} from "./browser-assets";

const repoRoot = path.resolve(import.meta.dir, "..");

describe("embedded browser assets", () => {
  test("embeds the complete offline shell with no external network references", () => {
    assertBrowserAssetsCurrent(repoRoot);
    expect(EMBEDDED_BROWSER_ASSETS["review.html"]).toContain("./bootstrap.js");
    expect(EMBEDDED_BROWSER_ASSETS["review.html"]).toContain("./review.css");
    expect(
      `${EMBEDDED_BROWSER_ASSETS["review.html"]}\n${EMBEDDED_BROWSER_ASSETS["review.css"]}`,
    ).not.toMatch(/https?:\/\//);
    expect(EMBEDDED_BROWSER_ASSETS["bootstrap.js"]).not.toMatch(
      /(?:fetch|import)\s*\(\s*["']https?:\/\//,
    );
    expect(readFileSync(path.join(repoRoot, "src/browser/generated/assets.ts"), "utf8")).toBe(
      renderBrowserAssetModule(repoRoot),
    );
  });

  test("broker loads the large generated module only inside the asset route", () => {
    const server = readFileSync(
      path.join(repoRoot, "src/session/broker/browserReviewServer.ts"),
      "utf8",
    );
    expect(server).not.toContain("import { EMBEDDED_BROWSER_ASSETS }");
    expect(server).toContain('import("../../browser/generated/assets")');
  });

  test("transitive shared STML changes invalidate the browser output", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hunk-browser-transitive-test-"));
    try {
      mkdirSync(path.join(root, "src"), { recursive: true });
      cpSync(path.join(repoRoot, "src/web"), path.join(root, "src/web"), { recursive: true });
      cpSync(path.join(repoRoot, "src/core/review"), path.join(root, "src/core/review"), {
        recursive: true,
      });
      symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "dir");
      const shared = path.join(root, "src/core/review/stml.ts");
      const original = readFileSync(shared, "utf8");
      const baseline = await subprocessBundleDigest(root);
      writeFileSync(shared, original.replace("maxDepth: 32", "maxDepth: 31"));
      expect(await subprocessBundleDigest(root)).not.toBe(baseline);
      await assertBrowserBundleCurrent(repoRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("fails clearly when generated assets are missing or stale", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hunk-browser-assets-"));
    try {
      mkdirSync(path.join(root, "src/browser"), { recursive: true });
      cpSync(path.join(repoRoot, "src/browser/assets"), path.join(root, "src/browser/assets"), {
        recursive: true,
      });
      expect(() => assertBrowserAssetsCurrent(root)).toThrow("Missing generated browser assets");
      mkdirSync(path.join(root, "src/browser/generated"), { recursive: true });
      generateBrowserAssets(root);
      writeFileSync(path.join(root, "src/browser/assets/review.css"), "changed");
      expect(() => assertBrowserAssetsCurrent(root)).toThrow("stale");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function subprocessBundleDigest(root: string) {
  const modulePath = path.join(repoRoot, "scripts/browser-assets.ts");
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      `import { createHash } from "node:crypto"; import { buildBrowserAssetBundle } from ${JSON.stringify(modulePath)}; const output = await buildBrowserAssetBundle(${JSON.stringify(root)}, false); console.log(createHash("sha256").update(output).digest("hex"));`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}
