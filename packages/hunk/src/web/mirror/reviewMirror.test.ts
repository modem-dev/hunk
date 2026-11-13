import { afterEach, describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { serveTestWebReview } from "../../../../../test/helpers/web-review-server";
import { ReviewApiError, type ReviewApiClient } from "../transport/apiClient";
import { ReviewMirror, type ReviewMirrorSnapshot } from "./reviewMirror";

const running: Array<() => void> = [];

afterEach(() => {
  for (const stop of running.splice(0)) stop();
});

/** Three real files served by a real review API. */
function createTestFiles(suffix = "") {
  return ["alpha", "beta", "gamma"].map((id) =>
    createTestDiffFile({
      id: `${id}${suffix}`,
      path: `src/${id}.ts`,
      after: `export const ${id} = "${suffix || "first"}";\n`,
      before: `export const ${id} = 0;\n`,
    }),
  );
}

/** Serve files and remember to stop. */
function serve(files = createTestFiles()) {
  const served = serveTestWebReview(files);
  running.push(served.stop);
  return served;
}

/** Wait until the mirror reports a status, or fail. */
async function waitForTestStatus(mirror: ReviewMirror, status: ReviewMirrorSnapshot["status"]) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const snapshot = mirror.getSnapshot();
    if (snapshot.status === status && !snapshot.updating) return snapshot;
    await Bun.sleep(5);
  }
  throw new Error(`Mirror never reached ${status}; it is ${mirror.getSnapshot().status}.`);
}

/** A mirror that notifies synchronously, recording every snapshot it publishes. */
function createTestMirror(client: ReviewApiClient) {
  const mirror = new ReviewMirror({ client, scheduleNotify: (flush) => flush() });
  const seen: ReviewMirrorSnapshot[] = [];
  mirror.subscribe(() => seen.push(mirror.getSnapshot()));
  running.push(() => mirror.close());
  return { mirror, seen };
}

describe("ReviewMirror", () => {
  test("loads the first generation progressively, in catalog order", async () => {
    const served = serve();
    const client = served.client();
    const { mirror, seen } = createTestMirror(client);

    expect(mirror.observe(await client.publication())).toBe("gap");
    const ready = await waitForTestStatus(mirror, "ready");

    expect(ready.document.files.map((file) => file.key)).toEqual(
      served.harness.producer.getPublication().document.files.map((file) => file.key),
    );
    expect(ready.document).toEqual(served.harness.producer.getPublication().document);
    // Partial progress was published along the way, never more files than had loaded.
    const loading = seen.filter((snapshot) => snapshot.status === "loading");
    expect(loading[0]?.loadedFiles).toBe(0);
    expect(loading.map((snapshot) => snapshot.document.files.length)).toEqual(
      loading.map((snapshot) => snapshot.loadedFiles),
    );
    expect(ready.slots.every((slot) => slot.index?.path === slot.file?.path)).toBe(true);
  });

  test("ignores a stale publication and moves on an accepted one", async () => {
    const served = serve();
    const client = served.client();
    const { mirror } = createTestMirror(client);
    const first = await client.publication();
    mirror.observe(first);
    await waitForTestStatus(mirror, "ready");

    served.harness.producer.applyIntent({ type: "filter/set", filter: "beta" });
    served.harness.publishSnapshot();
    const next = await client.publication();

    expect(mirror.observe(first)).toBe("stale");
    expect(mirror.observe(next)).toBe("accepted");
    expect(mirror.getSnapshot().address).toEqual(next.publication);
    expect(mirror.getSnapshot().status).toBe("ready");
  });

  // Intent: a newer generation supersedes an older load still running (C3), and a reload
  // replaces the document only once the new generation has fully loaded.
  test("supersedes an older generation's load with a newer one", async () => {
    const served = serve();
    const client = served.client();
    const { mirror, seen } = createTestMirror(client);
    mirror.observe(await client.publication());
    await waitForTestStatus(mirror, "ready");
    const registration = served.harness.register();

    served.harness.producer.publish({ files: createTestFiles("second"), sourceLabel: "/repo" });
    served.harness.register(registration);
    const second = await client.publication();
    served.harness.producer.publish({ files: createTestFiles("third"), sourceLabel: "/repo" });
    served.harness.register(registration);
    const third = await client.publication();
    const shownBefore = seen.length;

    expect(mirror.observe(second)).toBe("gap");
    expect(mirror.observe(third)).toBe("gap");
    const ready = await waitForTestStatus(mirror, "ready");

    expect(ready.address).toEqual(third.publication);
    expect(ready.error).toBeUndefined();
    expect(ready.document.files.map((file) => file.additionLines.join())).toEqual(
      served.harness.producer
        .getPublication()
        .document.files.map((file) => file.additionLines.join()),
    );
    // While the reload ran the old document stayed on screen, never a partial new one.
    const during = seen.slice(shownBefore, -1);
    expect(during.every((snapshot) => snapshot.document.files.length === 3)).toBe(true);
  });

  test("keeps showing the current generation when a reload fails", async () => {
    const served = serve();
    const realClient = served.client();
    let failReads = false;
    const client = Object.assign(Object.create(realClient) as ReviewApiClient, {
      readResources: (...args: Parameters<ReviewApiClient["readResources"]>) => {
        if (failReads) throw new ReviewApiError("resource-unavailable", "unavailable");
        return realClient.readResources(...args);
      },
    });
    const { mirror } = createTestMirror(client);
    mirror.observe(await realClient.publication());
    const before = await waitForTestStatus(mirror, "ready");
    const registration = served.harness.register();
    served.harness.producer.publish({ files: createTestFiles("second"), sourceLabel: "/repo" });
    served.harness.register(registration);
    failReads = true;

    mirror.observe(await realClient.publication());
    for (let attempt = 0; attempt < 100 && !mirror.getSnapshot().error; attempt += 1) {
      await Bun.sleep(5);
    }

    expect(mirror.getSnapshot().document).toBe(before.document);
    expect(mirror.getSnapshot().error?.code).toBe("resource-unavailable");
    expect(mirror.getSnapshot().updating).toBe(false);
  });

  // Intent: a reconnect redelivers the same publication; a generation whose files failed to
  // load must load again then, not be dismissed as already seen.
  test("retries a failed generation when the same publication arrives again", async () => {
    const served = serve();
    const realClient = served.client();
    let failReads = true;
    const client = Object.assign(Object.create(realClient) as ReviewApiClient, {
      readResources: (...args: Parameters<ReviewApiClient["readResources"]>) => {
        if (failReads) throw new ReviewApiError("resource-unavailable", "unavailable");
        return realClient.readResources(...args);
      },
    });
    const { mirror } = createTestMirror(client);
    const publication = await realClient.publication();

    mirror.observe(publication);
    await waitForTestStatus(mirror, "failed");
    failReads = false;
    mirror.observe(publication);
    const ready = await waitForTestStatus(mirror, "ready");

    expect(ready.document.files).toHaveLength(3);
    expect(ready.error).toBeUndefined();
  });

  // Intent: without the shared file index (its read failed), entries come from canonical
  // files and must still carry the agent summary, or the filter hides files matching it.
  test("keeps each file's agent summary when entries come from canonical files", async () => {
    const files = createTestFiles();
    files[1] = {
      ...files[1]!,
      agent: { path: files[1]!.path, summary: "Beta summary", annotations: [] },
    };
    const served = serve(files);
    const client = served.client();
    const { mirror } = createTestMirror(client);

    mirror.observe(await client.publication());
    const ready = await waitForTestStatus(mirror, "ready");

    expect(ready.slots.map((slot) => slot.index?.agentSummary)).toEqual([
      undefined,
      "Beta summary",
      undefined,
    ]);
  });

  test("uses an index source ahead of canonical files when one is given", async () => {
    const served = serve();
    const client = served.client();
    const mirror = new ReviewMirror({
      client,
      scheduleNotify: (flush) => flush(),
      indexSource: async (catalog) =>
        new Map(
          catalog.resources
            .filter((resource) => resource.kind === "canonical-file")
            .map((resource, index) => [
              resource.fileKey,
              {
                key: resource.fileKey,
                path: `indexed-${index}.ts`,
                changeKind: "change" as const,
                stats: { additions: 1, deletions: 1, truncated: false },
                flags: { untracked: false, binary: false, tooLarge: false, partial: false },
                splitLineCount: 1,
                unifiedLineCount: 2,
                hunkCount: 1,
              },
            ]),
        ),
    });
    running.push(() => mirror.close());

    mirror.observe(await client.publication());
    const ready = await waitForTestStatus(mirror, "ready");

    expect(ready.slots.map((slot) => slot.index?.path)).toEqual([
      "indexed-0.ts",
      "indexed-1.ts",
      "indexed-2.ts",
    ]);
  });
});
