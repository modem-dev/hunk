import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { BrowserReviewSnapshot } from "../../src/web/lib/reviewTypes";

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

async function keepEventSourceOpen(page: Page) {
  await page.addInitScript(() => {
    class TestEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readonly url = "";
      readonly withCredentials = true;
      readyState = 1;
      onopen: ((event: Event) => unknown) | null = null;
      onerror: ((event: Event) => unknown) | null = null;
      onmessage: ((event: MessageEvent) => unknown) | null = null;
      constructor() {
        super();
        (window as unknown as { __hunkTestEventSource: TestEventSource }).__hunkTestEventSource =
          this;
        setTimeout(() => this.onopen?.(new Event("open")), 0);
      }
      close() {
        this.readyState = 2;
      }
    }
    Object.defineProperty(window, "EventSource", { value: TestEventSource });
  });
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
): BrowserReviewSnapshot {
  return {
    generation,
    manifest: {
      version: 1 as const,
      generation,
      documentIdentity: `review:${generation}`,
      changesetId: `changes:${generation}`,
      title: "Browser review",
      sourceLabel: "fixture",
      files: entries.map(
        (entry) => entry.manifest,
      ) as unknown as BrowserReviewSnapshot["manifest"]["files"],
      resources: entries.map(
        (entry) => entry.resource,
      ) as BrowserReviewSnapshot["manifest"]["resources"],
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
  const search = page.getByLabel("Search changed files");
  await search.fill("duplicate.ts");
  await expect(page.getByRole("treeitem", { name: "duplicate.ts" })).toHaveCount(2);
  await expect(page.locator("[data-review-stream] > [data-file-key]")).toHaveCount(2);
  await search.fill("");
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

test("multi-hunk files render isolated Pierre inputs without asynchronous highlight errors", async ({
  page,
}) => {
  const entry = reviewFile("multi", { filePath: "src/multi.ts" });
  const canonical = JSON.parse(entry.content) as {
    additionLines: string[];
    deletionLines: string[];
    hunks: Array<Record<string, unknown>>;
  };
  const first = canonical.hunks[0]!;
  canonical.additionLines.push("second new");
  canonical.deletionLines.push("second old");
  canonical.hunks.push({
    ...first,
    index: 1,
    splitLineStart: 1,
    unifiedLineStart: 2,
    additionStart: 10,
    deletionStart: 10,
    additionLineIndex: 1,
    deletionLineIndex: 1,
    hunkContent: [
      {
        type: "change",
        additions: 1,
        deletions: 1,
        additionLineIndex: 1,
        deletionLineIndex: 1,
      },
    ],
    hunkSpecs: "@@ -10 +10 @@",
  });
  entry.content = JSON.stringify(canonical);
  entry.manifest.hunkCount = 2;
  entry.manifest.hunks.push({
    index: 1,
    header: "@@ -10 +10 @@",
    oldRange: [10, 10],
    newRange: [10, 10],
  });
  entry.resource.byteLength = Buffer.byteLength(entry.content);
  entry.resource.digest = createHash("sha256").update(entry.content).digest("hex");
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await routeReviewShell(page);
  await page.route("**/review-api/session/snapshot", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(reviewSnapshot("generation:browser", [entry])),
    }),
  );
  await page.route("**/review-api/session/events", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": heartbeat\n\n" }),
  );
  await page.route("**/review-api/session/resources/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: entry.resource.contentType,
      body: entry.content,
    }),
  );

  await page.goto("/review/session#capability=test-capability");
  await expect(page.getByText("second new", { exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  expect(consoleErrors).toEqual([]);
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
  await expect(liveFile).toHaveAttribute("data-resource-state", "ready", { timeout: 10_000 });
  await expect(page.locator('[data-note-id="note:live"]')).toBeVisible();
  await expect(page.getByText("Resource error")).toHaveCount(0);
  expect(oldRequests).toBeGreaterThan(0);
  expect(newRequests).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test("browser semantic actions confirm note CRUD, visibility, filtering, and reload preconditions", async ({
  page,
}) => {
  const generation = "generation:mutations";
  const entry = reviewFile("mutable", { generation, filePath: "src/mutable.ts" });
  const snapshot = reviewSnapshot(generation, [entry]);
  snapshot.manifest.capabilities = {
    actions: [
      "selection/select",
      "selection/set-line",
      "filter/set",
      "notes/set-visibility",
      "notes/create-user",
      "notes/update-user",
      "notes/remove-user",
      "session/reload",
    ],
    canReload: true,
  };
  snapshot.state.reveal = {
    token: 0,
    fileTopToken: 0,
    hunkToken: 0,
    lineToken: 0,
    kind: "hunk",
    scrollToNote: false,
  };
  const actionBodies: Array<Record<string, any>> = [];
  let snapshotReads = 0;
  let delayRecovery = false;
  let advanceSnapshotOnNextRead = false;
  let releaseRecovery: (() => void) | undefined;
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });

  await routeReviewShell(page);
  await page.route("**/review-api/session/snapshot", async (route) => {
    snapshotReads += 1;
    const advance = advanceSnapshotOnNextRead;
    advanceSnapshotOnNextRead = false;
    if (delayRecovery) await recoveryGate;
    if (advance) snapshot.state.stateRevision += 1;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) });
  });
  await page.route("**/review-api/session/events", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": heartbeat\n\n" }),
  );
  await page.route("**/review-api/session/resources/**", (route) =>
    route.fulfill({ contentType: entry.resource.contentType, body: entry.content }),
  );
  await page.route("**/review-api/session/actions", async (route) => {
    const body = route.request().postDataJSON() as Record<string, any>;
    actionBodies.push(body);
    if (
      body.generation !== snapshot.generation ||
      body.expectedStateRevision !== snapshot.state.stateRevision
    ) {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          kind: "review-error",
          error: { code: "stale-revision", message: "stale" },
        }),
      });
    }
    const action = body.action;
    if (action.type === "notes/create-user") {
      snapshot.state.notes.push({
        id: "user:browser",
        source: "user",
        origin: "user",
        fileKey: action.note.fileKey,
        anchor: {
          newRange: [action.note.line, action.note.line],
          preferred: { side: action.note.side, line: action.note.line },
          intersectingHunkIndices: [0],
          ownerHunkIndex: 0,
        },
        summary: action.note.body,
        author: "user",
        editable: true,
      });
    } else if (action.type === "notes/update-user") {
      snapshot.state.notes[0]!.summary = action.body;
      if (action.markup?.trim()) snapshot.state.notes[0]!.markup = action.markup;
      else delete snapshot.state.notes[0]!.markup;
    } else if (action.type === "notes/remove-user") {
      snapshot.state.notes = snapshot.state.notes.filter((note) => note.id !== action.noteId);
    } else if (action.type === "notes/set-visibility") {
      snapshot.state.showAgentNotes = action.visible;
    } else if (action.type === "filter/set") {
      snapshot.state.filter = action.filter;
    }
    snapshot.state.stateRevision += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        kind: "review-action",
        generation,
        stateRevision: snapshot.state.stateRevision,
        state: snapshot.state,
      }),
    });
  });

  await keepEventSourceOpen(page);
  await page.goto("/review/session#capability=test-capability");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await page.getByLabel("Add review note").getByRole("textbox").fill("Browser authored note");
  await page.getByRole("button", { name: /Add note/ }).click();
  await expect(page.locator('[data-note-id="user:browser"]')).toContainText(
    "Browser authored note",
  );
  await page.locator('[data-note-id="user:browser"]').getByRole("button", { name: "Edit" }).click();
  const userNote = page.locator('[data-note-id="user:browser"]');
  await userNote.getByRole("textbox").first().fill("Edited in browser");
  await userNote.getByRole("textbox", { name: "STML markup" }).fill("<b>Styled edit</b>");
  await userNote.getByRole("button", { name: "Save" }).click();
  await expect(userNote.locator("strong")).toHaveText("Styled edit");

  await userNote.getByRole("button", { name: "Edit" }).click();
  snapshot.state.stateRevision += 1;
  await page.evaluate((state) => {
    const source = (window as unknown as { __hunkTestEventSource: EventSource })
      .__hunkTestEventSource;
    source.dispatchEvent(
      new MessageEvent("state", {
        data: JSON.stringify({ generation: state.documentGeneration, state }),
      }),
    );
  }, snapshot.state);
  await userNote.getByRole("textbox").first().fill("Conflicting edit");
  advanceSnapshotOnNextRead = true;
  await userNote.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Review changed; refreshed/)).toBeVisible();
  await userNote.getByRole("button", { name: "Cancel" }).click();

  await userNote.getByRole("button", { name: "Edit" }).click();
  await userNote.getByRole("textbox").first().fill("Markup cleared");
  await userNote.getByRole("textbox", { name: "STML markup" }).fill("");
  await userNote.getByRole("button", { name: "Save" }).click();
  await expect(userNote.locator(".review-note__summary")).toHaveText("Markup cleared");
  await userNote.getByRole("button", { name: "Remove" }).click();
  await expect(page.locator('[data-note-id="user:browser"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Hide agent notes" }).click();
  const showNotes = page.getByRole("button", { name: "Show agent notes" });
  await expect(showNotes).toBeEnabled();
  delayRecovery = true;
  advanceSnapshotOnNextRead = true;
  await page.evaluate(() => {
    const source = (window as unknown as { __hunkTestEventSource: EventSource })
      .__hunkTestEventSource;
    source.onerror?.(new Event("error"));
  });
  await expect(showNotes).toBeDisabled();
  await page.evaluate(() => {
    const source = (window as unknown as { __hunkTestEventSource: EventSource })
      .__hunkTestEventSource;
    source.onopen?.(new Event("open"));
  });
  await expect(showNotes).toBeDisabled();
  expect(snapshotReads).toBeGreaterThanOrEqual(2);
  releaseRecovery?.();
  await expect(showNotes).toBeEnabled();
  await page.getByLabel("Review file filter").fill("mutable");
  await page.getByRole("button", { name: "Apply filter" }).click();
  expect(actionBodies.map((body) => body.expectedStateRevision)).toEqual([1, 2, 3, 5, 6, 7, 9]);
  expect(actionBodies.map((body) => body.action.type)).toEqual([
    "notes/create-user",
    "notes/update-user",
    "notes/update-user",
    "notes/update-user",
    "notes/remove-user",
    "notes/set-visibility",
    "filter/set",
  ]);
});

test("failed reconnect recovery stays read-only through deltas and retries a complete snapshot", async ({
  page,
}) => {
  const generation = "generation:recovery-gate";
  const entry = reviewFile("recovery", { generation, filePath: "src/recovery.ts" });
  const snapshot = reviewSnapshot(generation, [entry]);
  snapshot.manifest.capabilities = { actions: ["notes/set-visibility"] };
  let snapshotReads = 0;
  let successfulSnapshots = 0;
  let failRecoveries = false;
  let pendingFailures = 0;
  let completedFailures = 0;
  let releaseFailure: (() => void) | undefined;
  const delayedFailure = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });

  await routeReviewShell(page);
  await page.route("**/review-api/session/snapshot", async (route) => {
    snapshotReads += 1;
    if (failRecoveries) {
      pendingFailures += 1;
      await delayedFailure;
      await route.fulfill({ status: 500, body: "recovery failed" });
      pendingFailures -= 1;
      completedFailures += 1;
      return;
    }
    successfulSnapshots += 1;
    const complete = structuredClone(snapshot);
    if (successfulSnapshots > 1) complete.state.stateRevision += 1;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(complete) });
  });
  await page.route("**/review-api/session/resources/**", (route) =>
    route.fulfill({ contentType: entry.resource.contentType, body: entry.content }),
  );
  await keepEventSourceOpen(page);

  await page.goto("/review/session#capability=test-capability");
  const visibility = page.getByRole("button", { name: "Hide agent notes" });
  await expect(visibility).toBeEnabled();
  await expect.poll(() => successfulSnapshots).toBe(1);
  failRecoveries = true;
  await page.evaluate(() => {
    const source = (window as unknown as { __hunkTestEventSource: EventSource })
      .__hunkTestEventSource;
    source.onerror?.(new Event("error"));
  });
  await expect(page.getByText("Reconnecting…", { exact: true })).toBeVisible();
  await expect(visibility).toBeDisabled();
  await page.evaluate(() => {
    const source = (window as unknown as { __hunkTestEventSource: EventSource })
      .__hunkTestEventSource;
    source.onopen?.(new Event("open"));
  });
  await expect.poll(() => pendingFailures).toBeGreaterThan(0);
  await expect(visibility).toBeDisabled();

  snapshot.state.stateRevision = 2;
  await page.evaluate((state) => {
    const source = (window as unknown as { __hunkTestEventSource: EventSource })
      .__hunkTestEventSource;
    source.dispatchEvent(
      new MessageEvent("state", {
        data: JSON.stringify({ generation: state.documentGeneration, state }),
      }),
    );
  }, snapshot.state);
  releaseFailure?.();
  await expect.poll(() => completedFailures).toBeGreaterThan(0);
  await expect.poll(() => pendingFailures).toBe(0);
  failRecoveries = false;
  await page.waitForTimeout(20);
  await expect(page.getByText("Reconnecting…", { exact: true })).toBeVisible();
  await expect(visibility).toBeDisabled();

  snapshot.state.stateRevision = 3;
  await page.evaluate((state) => {
    const source = (window as unknown as { __hunkTestEventSource: EventSource })
      .__hunkTestEventSource;
    source.dispatchEvent(
      new MessageEvent("state", {
        data: JSON.stringify({ generation: state.documentGeneration, state }),
      }),
    );
  }, snapshot.state);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(visibility).toBeEnabled();
  expect(successfulSnapshots).toBe(2);
  expect(snapshotReads).toBeGreaterThanOrEqual(3);
});

test("quiet reconnect accepts an unchanged complete snapshot", async ({ page }) => {
  const generation = "generation:quiet-reconnect";
  const entry = reviewFile("quiet-reconnect", {
    generation,
    filePath: "src/quiet-reconnect.ts",
  });
  const snapshot = reviewSnapshot(generation, [entry]);
  snapshot.manifest.capabilities = { actions: ["notes/set-visibility"] };
  let snapshotReads = 0;

  await routeReviewShell(page);
  await page.route("**/review-api/session/snapshot", (route) => {
    snapshotReads += 1;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) });
  });
  await page.route("**/review-api/session/resources/**", (route) =>
    route.fulfill({ contentType: entry.resource.contentType, body: entry.content }),
  );
  await keepEventSourceOpen(page);

  await page.goto("/review/session#capability=test-capability");
  const visibility = page.getByRole("button", { name: "Hide agent notes" });
  await expect(visibility).toBeEnabled();
  await page.evaluate(() => {
    const source = (window as unknown as { __hunkTestEventSource: EventSource })
      .__hunkTestEventSource;
    source.onerror?.(new Event("error"));
    source.onopen?.(new Event("open"));
  });

  await expect.poll(() => snapshotReads).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(visibility).toBeEnabled();
});

test("recovery accepts a newer complete SSE generation while its older snapshot is delayed", async ({
  page,
}) => {
  const oldGeneration = "generation:recovery-old";
  const newGeneration = "generation:recovery-new";
  const oldEntry = reviewFile("recovery-race", {
    generation: oldGeneration,
    filePath: "src/recovery-old.ts",
  });
  const newEntry = reviewFile("recovery-race", {
    generation: newGeneration,
    filePath: "src/recovery-new.ts",
  });
  const oldSnapshot = reviewSnapshot(oldGeneration, [oldEntry]);
  const newSnapshot = reviewSnapshot(newGeneration, [newEntry]);
  oldSnapshot.manifest.capabilities = { actions: ["notes/set-visibility"] };
  newSnapshot.manifest.capabilities = { actions: ["notes/set-visibility"] };
  let snapshotReads = 0;
  let releaseOldSnapshot: (() => void) | undefined;
  const oldSnapshotGate = new Promise<void>((resolve) => {
    releaseOldSnapshot = resolve;
  });

  await routeReviewShell(page);
  await page.route("**/review-api/session/snapshot", async (route) => {
    snapshotReads += 1;
    if (snapshotReads > 1) await oldSnapshotGate;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(oldSnapshot) });
  });
  await page.route("**/review-api/session/resources/**", (route) => {
    const generation = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-2)!,
    );
    const entry = generation === newGeneration ? newEntry : oldEntry;
    return route.fulfill({ contentType: entry.resource.contentType, body: entry.content });
  });
  await keepEventSourceOpen(page);

  await page.goto("/review/session#capability=test-capability");
  await expect(page.locator('[data-file-key="recovery-race"]')).toHaveAttribute(
    "data-file-path",
    "src/recovery-old.ts",
  );
  await page.evaluate(() => {
    const source = (window as unknown as { __hunkTestEventSource: EventSource })
      .__hunkTestEventSource;
    source.onerror?.(new Event("error"));
  });
  await page.evaluate(() => {
    const source = (window as unknown as { __hunkTestEventSource: EventSource })
      .__hunkTestEventSource;
    source.onopen?.(new Event("open"));
  });
  await expect.poll(() => snapshotReads).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(20);
  const readsBeforeNewGeneration = snapshotReads;
  await page.evaluate((complete) => {
    const source = (window as unknown as { __hunkTestEventSource: EventSource })
      .__hunkTestEventSource;
    source.dispatchEvent(new MessageEvent("document", { data: JSON.stringify(complete) }));
  }, newSnapshot);
  await expect(page.locator('[data-file-key="recovery-race"]')).toHaveAttribute(
    "data-file-path",
    "src/recovery-new.ts",
  );
  releaseOldSnapshot?.();

  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide agent notes" })).toBeEnabled();
  await page.waitForTimeout(50);
  expect(snapshotReads).toBe(readsBeforeNewGeneration);
});

test("expanded source renders at its addressed semantic gap", async ({ page }) => {
  const generation = "generation:expanded-position";
  const entry = reviewFile("expanded", { generation, filePath: "src/expanded.ts" });
  const sourceId = "source:expanded:new";
  const sourceText = "context line\nnew expanded\n";
  const canonical = JSON.parse(entry.content);
  canonical.sourceResourceIds = { new: sourceId };
  entry.content = JSON.stringify(canonical);
  entry.resource.byteLength = Buffer.byteLength(entry.content);
  entry.resource.digest = createHash("sha256").update(entry.content).digest("hex");
  entry.manifest.sourceResourceIds = { new: sourceId };
  const snapshot = reviewSnapshot(generation, [entry]);
  snapshot.manifest.resources.push({
    id: sourceId,
    kind: "source",
    generation,
    fileKey: "expanded",
    side: "new",
    sourceIdentity: "source-identity",
    contentType: "text/plain; charset=utf-8",
    byteLength: Buffer.byteLength(sourceText),
    digest: createHash("sha256").update(sourceText).digest("hex"),
  });
  snapshot.state.expandedGaps = [
    {
      fileKey: "expanded",
      gapId: "before:0",
      side: "new",
      oldRange: [1, 1],
      newRange: [1, 1],
      sourceIdentity: "source-identity",
      expanded: true,
    },
  ];
  snapshot.state.sourceStatusByFileKey = { expanded: { kind: "loaded" } };

  await routeReviewShell(page);
  await page.route("**/review-api/session/snapshot", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }),
  );
  await page.route("**/review-api/session/resources/**", (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
    return route.fulfill({
      contentType: id === sourceId ? "text/plain" : entry.resource.contentType,
      body: id === sourceId ? sourceText : entry.content,
    });
  });
  await keepEventSourceOpen(page);
  await page.goto("/review/session#capability=test-capability");
  const hunk = page.locator('[data-review-hunk="0"]');
  const gap = hunk.locator(':scope > [data-gap-id="before:0"]');
  await expect(gap).toContainText("Expanded new line 1");
  await expect(gap).not.toContainText("lines 1–1");
  await expect(gap).toContainText("context line");
  expect(
    await hunk.evaluate((element) => {
      const gap = element.querySelector('[data-gap-id="before:0"]')!;
      return element.firstElementChild === gap && gap.nextElementSibling !== null;
    }),
  ).toBe(true);
});

test("failed expanded source stays inline at its gap without fetching or hiding the diff", async ({
  page,
}) => {
  const generation = "generation:expanded-error";
  const entry = reviewFile("failed", { generation, filePath: "src/failed.ts" });
  const sourceId = "source:failed:new";
  const canonical = JSON.parse(entry.content);
  canonical.sourceResourceIds = { new: sourceId };
  entry.content = JSON.stringify(canonical);
  entry.resource.byteLength = Buffer.byteLength(entry.content);
  entry.resource.digest = createHash("sha256").update(entry.content).digest("hex");
  entry.manifest.sourceResourceIds = { new: sourceId };
  const snapshot = reviewSnapshot(generation, [entry]);
  snapshot.manifest.resources.push({
    id: sourceId,
    kind: "source",
    generation,
    fileKey: "failed",
    side: "new",
    sourceIdentity: "failed-source",
    contentType: "text/plain; charset=utf-8",
  });
  snapshot.state.expandedGaps = [
    {
      fileKey: "failed",
      gapId: "before:0",
      side: "new",
      oldRange: [1, 1],
      newRange: [1, 1],
      sourceIdentity: "failed-source",
      expanded: true,
    },
  ];
  snapshot.state.sourceStatusByFileKey = { failed: { kind: "error" } };
  let sourceRequests = 0;

  await routeReviewShell(page);
  await page.route("**/review-api/session/snapshot", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }),
  );
  await page.route("**/review-api/session/resources/**", (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
    if (id === sourceId) sourceRequests += 1;
    return route.fulfill({
      contentType: entry.resource.contentType,
      body: id === sourceId ? "must not load" : entry.content,
    });
  });
  await keepEventSourceOpen(page);
  await page.goto("/review/session#capability=test-capability");

  const hunk = page.locator('[data-review-hunk="0"]');
  const error = hunk.locator(':scope > [data-gap-id="before:0"]');
  await expect(error).toHaveRole("alert");
  await expect(error).toContainText("Expanded source could not be loaded");
  await expect(hunk).toContainText("old failed");
  await expect(hunk).toContainText("new failed");
  expect(sourceRequests).toBe(0);
  expect(
    await hunk.evaluate((element) => {
      const gap = element.querySelector('[data-gap-id="before:0"]')!;
      return element.firstElementChild === gap && gap.nextElementSibling !== null;
    }),
  ).toBe(true);
});

test("remote reveal waits for off-window rows and unrelated revisions preserve scroll", async ({
  page,
}) => {
  const generation = "generation:remote-reveal";
  const entries = Array.from({ length: 20 }, (_, index) =>
    reviewFile(`remote-${index}`, {
      generation,
      filePath: `src/remote-${String(index).padStart(2, "0")}.ts`,
    }),
  );
  const snapshot = reviewSnapshot(generation, entries);
  snapshot.state.reveal = {
    token: 0,
    fileTopToken: 0,
    hunkToken: 0,
    lineToken: 0,
    kind: "hunk",
    scrollToNote: false,
  };
  await page.addInitScript(() => {
    (window as unknown as { __scrollTargets: string[] }).__scrollTargets = [];
    HTMLElement.prototype.scrollIntoView = function () {
      const file = this.closest<HTMLElement>("[data-file-key]");
      (window as unknown as { __scrollTargets: string[] }).__scrollTargets.push(
        file?.dataset.fileKey ?? "unknown",
      );
    };
  });
  await routeReviewShell(page);
  await page.route("**/review-api/session/snapshot", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }),
  );
  await page.route("**/review-api/session/resources/**", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
    const entry = entries.find((candidate) => candidate.resource.id === id)!;
    if (entry.manifest.key === "remote-19") await new Promise((resolve) => setTimeout(resolve, 80));
    await route.fulfill({ contentType: entry.resource.contentType, body: entry.content });
  });
  await keepEventSourceOpen(page);
  await page.goto("/review/session#capability=test-capability");
  await expect(page.locator('[data-file-key="remote-0"]')).toHaveAttribute(
    "data-resource-state",
    "ready",
    { timeout: 10_000 },
  );
  const before = await page.evaluate(
    () => (window as unknown as { __scrollTargets: string[] }).__scrollTargets.length,
  );
  snapshot.state.stateRevision += 1;
  snapshot.state.notes = [];
  await page.evaluate((state) => {
    const source = (window as unknown as { __hunkTestEventSource: EventSource })
      .__hunkTestEventSource;
    source.dispatchEvent(
      new MessageEvent("state", {
        data: JSON.stringify({ generation: state.documentGeneration, state }),
      }),
    );
  }, snapshot.state);
  await page.waitForTimeout(50);
  expect(
    await page.evaluate(
      () => (window as unknown as { __scrollTargets: string[] }).__scrollTargets.length,
    ),
  ).toBe(before);

  snapshot.state.stateRevision += 1;
  snapshot.state.selection = { fileKey: "remote-19", hunkIndex: 0 };
  snapshot.state.reveal = { ...snapshot.state.reveal!, token: 1, hunkToken: 1, kind: "hunk" };
  await page.evaluate((state) => {
    const source = (window as unknown as { __hunkTestEventSource: EventSource })
      .__hunkTestEventSource;
    source.dispatchEvent(
      new MessageEvent("state", {
        data: JSON.stringify({ generation: state.documentGeneration, state }),
      }),
    );
  }, snapshot.state);
  await expect(page.locator('[data-file-key="remote-19"]')).toHaveAttribute(
    "data-resource-state",
    "ready",
    { timeout: 10_000 },
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __scrollTargets: string[] }).__scrollTargets.at(-1),
      ),
    )
    .toBe("remote-19");
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
