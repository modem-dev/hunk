import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const asset = (name: string) =>
  readFileSync(path.join(repoRoot, "src/browser/assets", name), "utf8");

function reviewFile(
  key: string,
  {
    generation = "generation:browser",
    filePath = "duplicate.ts",
  }: { generation?: string; filePath?: string } = {},
) {
  const note = {
    id: `note:${key}`,
    source: "user",
    origin: "user",
    fileKey: key,
    anchor: {
      newRange: [1, 1],
      preferred: { side: "new", line: 1 },
      intersectingHunkIndices: [0],
      ownerHunkIndex: 0,
    },
    summary: `Note for ${key}`,
    editable: true,
  };
  const canonical = {
    key,
    runtimeId: `runtime:${key}`,
    path: filePath,
    changeKind: "change",
    stats: { additions: 1, deletions: 1, truncated: false },
    flags: { untracked: false, binary: false, tooLarge: false, partial: true },
    patchResourceId: `patch:${key}`,
    canonicalResourceId: `canonical:${key}`,
    sourceResourceIds: {},
    additionLines: [`new ${key}`],
    deletionLines: [`old ${key}`],
    hunks: [
      {
        index: 0,
        collapsedBefore: 0,
        splitLineCount: 1,
        splitLineStart: 0,
        unifiedLineCount: 2,
        unifiedLineStart: 0,
        additionCount: 1,
        additionStart: 1,
        additionLines: 1,
        deletionCount: 1,
        deletionStart: 1,
        deletionLines: 1,
        deletionLineIndex: 0,
        additionLineIndex: 0,
        hunkContent: [
          {
            type: "change",
            additions: 1,
            deletions: 1,
            additionLineIndex: 0,
            deletionLineIndex: 0,
          },
        ],
        hunkSpecs: "@@ -1 +1 @@",
        noEOFCRAdditions: false,
        noEOFCRDeletions: false,
      },
    ],
    notes: [note],
    expandedContext: [],
  };
  const content = JSON.stringify(canonical);
  return {
    content,
    manifest: {
      key,
      runtimeId: `runtime:${key}`,
      path: filePath,
      changeKind: "change",
      additions: 1,
      deletions: 1,
      statsTruncated: false,
      hunkCount: 1,
      flags: canonical.flags,
      patchResourceId: `patch:${key}`,
      canonicalResourceId: `canonical:${key}`,
      sourceResourceIds: {},
      hunks: [{ index: 0, header: "@@ -1 +1 @@", oldRange: [1, 1], newRange: [1, 1] }],
      notes: [note],
    },
    resource: {
      id: `canonical:${key}`,
      kind: "canonical-file",
      generation,
      fileKey: key,
      contentType: "application/vnd.hunk.review-file+json; charset=utf-8",
      byteLength: Buffer.byteLength(content),
      digest: createHash("sha256").update(content).digest("hex"),
    },
  };
}

async function routeReviewShell(page: Page) {
  await page.route("**/review/session", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: asset("review.html").replace("__HUNK_REVIEW_NONCE__", "test"),
    }),
  );
  await page.route("**/review/bootstrap.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: asset("bootstrap.js") }),
  );
  await page.route("**/review/review.css", (route) =>
    route.fulfill({ contentType: "text/css", body: asset("review.css") }),
  );
  await page.route("**/review-auth", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) }),
  );
}

function reviewSnapshot(
  generation: string,
  entries: ReturnType<typeof reviewFile>[],
  selectedFileKey = entries[0]!.manifest.key,
) {
  return {
    generation,
    manifest: {
      version: 1 as const,
      generation,
      documentIdentity: `review:${generation}`,
      changesetId: `changes:${generation}`,
      title: "Browser review",
      sourceLabel: "fixture",
      files: entries.map((entry) => entry.manifest),
      resources: entries.map((entry) => entry.resource),
      capabilities: { actions: [] },
    },
    state: {
      documentGeneration: generation,
      stateRevision: 1,
      selection: { fileKey: selectedFileKey, hunkIndex: 0 },
      filter: "",
      showAgentNotes: true,
      notes: [],
    },
  };
}

test("Tree selection jumps within one duplicate-path stream and notes render", async ({ page }) => {
  const entries = [reviewFile("first"), reviewFile("second")];
  const snapshot = reviewSnapshot("generation:browser", entries, "first");

  await page.route("**/review/session", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: asset("review.html").replace("__HUNK_REVIEW_NONCE__", "test"),
    }),
  );
  await page.route("**/review/bootstrap.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: asset("bootstrap.js") }),
  );
  await page.route("**/review/review.css", (route) =>
    route.fulfill({ contentType: "text/css", body: asset("review.css") }),
  );
  await page.route("**/review-auth", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) }),
  );
  await page.route("**/review-api/session/snapshot", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }),
  );
  await page.route("**/review-api/session/events", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": heartbeat\n\n" }),
  );
  await page.route("**/review-api/session/resources/**", (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
    const entry = entries.find((candidate) => candidate.resource.id === id)!;
    return route.fulfill({
      status: 200,
      contentType: entry.resource.contentType,
      body: entry.content,
    });
  });

  await page.goto("/review/session#capability=test-capability");
  await expect(page.locator("[data-review-stream] > [data-file-key]")).toHaveCount(2);
  await expect(page.locator('[data-note-id="note:first"]')).toBeVisible();
  const tree = page.locator('[aria-label="Changed files"]');
  await tree.evaluate((host) => {
    const leaves = Array.from(
      host.shadowRoot!.querySelectorAll<HTMLElement>("button[data-type='item']"),
    );
    leaves.at(-1)!.click();
  });
  await expect(page.locator('[data-file-key="second"]')).toBeFocused();
  await expect(page.locator('[data-file-key="first"]')).toHaveCount(1);
  await expect(page.locator('[data-file-key="second"]')).toHaveCount(1);
  await expect(page.locator('[data-note-id="note:second"]')).toBeVisible();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator(".web-review")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(".web-review")).toHaveAttribute("data-theme", "dark");
});

test("live document replacement aborts the old generation and renders the new resource", async ({
  page,
}) => {
  const oldGeneration = "generation:old-live";
  const newGeneration = "generation:new-live";
  const oldEntry = reviewFile("live", { generation: oldGeneration, filePath: "old-live.ts" });
  const newEntry = reviewFile("live", { generation: newGeneration, filePath: "new-live.ts" });
  const oldSnapshot = reviewSnapshot(oldGeneration, [oldEntry]);
  const newSnapshot = reviewSnapshot(newGeneration, [newEntry]);
  let oldRequests = 0;
  let newRequests = 0;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await routeReviewShell(page);
  await page.route("**/review-api/session/snapshot", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(oldSnapshot) }),
  );
  await page.route("**/review-api/session/events", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({
      contentType: "text/event-stream",
      body: `event: document\ndata: ${JSON.stringify(newSnapshot)}\n\n`,
    });
  });
  await page.route("**/review-api/session/resources/**", async (route) => {
    const requestGeneration = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-2)!,
    );
    const entry = requestGeneration === oldGeneration ? oldEntry : newEntry;
    if (requestGeneration === oldGeneration) {
      oldRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      newRequests += 1;
    }
    await route.fulfill({
      status: 200,
      contentType: entry.resource.contentType,
      body: entry.content,
    });
  });

  await page.goto("/review/session#capability=test-capability");
  const liveFile = page.locator('[data-file-key="live"]');
  await expect(liveFile).toHaveAttribute("data-file-path", "new-live.ts");
  await expect(liveFile).toHaveAttribute(
    "data-resource-key",
    /^generation:new-live.*canonical:live$/,
  );
  await expect(liveFile).toHaveAttribute("data-resource-state", "ready");
  await expect(page.locator('[data-note-id="note:live"]')).toBeVisible();
  await expect(page.getByText("Resource error")).toHaveCount(0);
  expect(oldRequests).toBeGreaterThan(0);
  expect(newRequests).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test("large review windowing bounds mounted diffs and preserves spacer order while scrolling", async ({
  page,
}) => {
  const generation = "generation:windowed";
  const entries = Array.from({ length: 80 }, (_, index) =>
    reviewFile(`window-${index}`, {
      generation,
      filePath: `src/file-${String(index).padStart(4, "0")}.ts`,
    }),
  );
  const snapshot = reviewSnapshot(generation, entries);
  let resourceRequests = 0;

  await routeReviewShell(page);
  await page.route("**/review-api/session/snapshot", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }),
  );
  await page.route("**/review-api/session/events", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": heartbeat\n\n" }),
  );
  await page.route("**/review-api/session/resources/**", (route) => {
    resourceRequests += 1;
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
    const entry = entries.find((candidate) => candidate.resource.id === id)!;
    return route.fulfill({
      status: 200,
      contentType: entry.resource.contentType,
      body: entry.content,
    });
  });

  await page.goto("/review/session#capability=test-capability");
  const files = page.locator("[data-review-stream] > [data-file-key]");
  await expect(files).toHaveCount(80);
  await expect(files.first()).toHaveAttribute("data-resource-state", "ready");
  await expect(page.locator("diffs-container").first()).toBeAttached();
  expect(await page.locator('[data-window-state="mounted"]').count()).toBeLessThanOrEqual(24);
  expect(await page.locator('[data-resource-state="ready"]').count()).toBeLessThanOrEqual(24);
  expect(await page.locator("diffs-container").count()).toBeLessThanOrEqual(24);
  expect(
    await files.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-file-path"))),
  ).toEqual(entries.map((entry) => entry.manifest.path));

  await files.last().scrollIntoViewIfNeeded();
  await expect(files.last()).toHaveAttribute("data-resource-state", "ready");
  await page.waitForTimeout(450);
  await expect(files.first()).toHaveAttribute("data-window-state", "spacer");
  await expect(files.first().locator(".review-file__spacer")).toHaveAttribute(
    "data-estimated-height",
    /\d+/,
  );
  expect(await page.locator('[data-window-state="mounted"]').count()).toBeLessThanOrEqual(24);
  expect(await page.locator('[data-resource-state="ready"]').count()).toBeLessThanOrEqual(24);
  expect(await page.locator("diffs-container").count()).toBeLessThanOrEqual(24);
  expect(await page.locator('[data-window-state="spacer"]').count()).toBeGreaterThan(40);
  expect(resourceRequests).toBeLessThan(80);

  const tree = page.locator('[aria-label="Changed files"]');
  const treeTargetPath = await tree.evaluate((host) => {
    const target = host.shadowRoot!.querySelector<HTMLElement>(
      "button[data-type='item'][data-item-type='file']",
    );
    target!.click();
    return target!.dataset.itemPath!;
  });
  const treeTarget = page.locator(`[data-review-stream] > [data-file-path="${treeTargetPath}"]`);
  await expect(treeTarget).toBeFocused();
  await expect(treeTarget).toHaveAttribute("data-window-state", "mounted");
  await expect(treeTarget).toHaveAttribute("data-resource-state", "ready");
  await page.waitForTimeout(450);
  expect(await page.locator('[data-window-state="mounted"]').count()).toBeLessThanOrEqual(24);
  expect(await page.locator("diffs-container").count()).toBeLessThanOrEqual(24);
});
