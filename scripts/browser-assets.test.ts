import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EMBEDDED_BROWSER_ASSETS } from "../src/browser/generated/assets";
import {
  assertBrowserAssetsCurrent,
  assertBrowserBundleCurrent,
  canRebuildCanonicalBrowserBundle,
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

  test("uses canonical rebuild checks on Unix and integrity-only checks on Windows", async () => {
    const rebuild = async () => {
      throw new Error("Windows must not invoke the host-dependent bundler.");
    };

    expect(canRebuildCanonicalBrowserBundle("linux")).toBe(true);
    expect(canRebuildCanonicalBrowserBundle("darwin")).toBe(true);
    expect(canRebuildCanonicalBrowserBundle("win32")).toBe(false);
    await expect(assertBrowserBundleCurrent(repoRoot, rebuild, "win32")).resolves.toBeUndefined();
    expect(() => assertBrowserAssetsCurrent(repoRoot)).not.toThrow();
  });

  test("rejects a rebuild changed by transitive shared input", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hunk-browser-transitive-test-"));
    try {
      const shared = path.join(root, "src/core/review/stml.ts");
      const bundle = path.join(root, "src/browser/assets/bootstrap.js");
      mkdirSync(path.dirname(shared), { recursive: true });
      mkdirSync(path.dirname(bundle), { recursive: true });
      writeFileSync(shared, "maxDepth: 32");
      const rebuild = async (currentRoot: string) =>
        `bundle:${readFileSync(path.join(currentRoot, "src/core/review/stml.ts"), "utf8")}`;
      writeFileSync(bundle, await rebuild(root));

      await expect(assertBrowserBundleCurrent(root, rebuild, "linux")).resolves.toBeUndefined();
      writeFileSync(shared, "maxDepth: 31");
      await expect(assertBrowserBundleCurrent(root, rebuild, "linux")).rejects.toThrow("stale");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
