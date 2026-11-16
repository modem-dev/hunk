import { describe, expect, test } from "bun:test";
import { reviewFileRole } from "./fileRoles";

describe("reviewFileRole", () => {
  test("classifies each role by its documented rules", () => {
    const cases: Array<[string, string]> = [
      ["src/app.ts", "source"],
      ["packages/hunk/src/core/review/overview.ts", "source"],
      ["src/app.test.ts", "test"],
      ["src/app.spec.tsx", "test"],
      ["pkg/server_test.go", "test"],
      ["tests/test_cli.py", "test"],
      ["test/web/review.e2e.ts", "test"],
      ["src/__tests__/thing.ts", "test"],
      ["README.md", "docs"],
      ["docs/web-review-client.md", "docs"],
      ["docs/diagram.svg", "docs"],
      ["LICENSE", "docs"],
      ["bun.lock", "generated"],
      ["web/package-lock.json", "generated"],
      ["go.sum", "generated"],
      ["dist/main.js", "generated"],
      ["assets/app.min.js", "generated"],
      ["src/__snapshots__/app.test.ts.snap", "generated"],
      ["api/types.generated.ts", "generated"],
      [".github/workflows/ci.yml", "config"],
      [".gitignore", "config"],
      ["package.json", "config"],
      ["tsconfig.base.json", "config"],
      ["vite.config.ts", "config"],
      ["Dockerfile", "config"],
    ];
    for (const [path, role] of cases) {
      expect([path, reviewFileRole(path)]).toEqual([path, role]);
    }
  });

  test("applies the documented precedence when rules overlap", () => {
    // Generated beats test, test beats docs, docs beats config.
    expect(reviewFileRole("test/dist/bundle.js")).toBe("generated");
    expect(reviewFileRole("test/fixtures/notes.md")).toBe("test");
    expect(reviewFileRole("docs/settings.json")).toBe("docs");
    expect(reviewFileRole(".changeset/web-review-hardening.md")).toBe("docs");
  });
});
