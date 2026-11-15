import { describe, expect, test } from "bun:test";
import { reviewErrorMessage } from "../../session/reviewErrorCatalog";
import type { HunkReviewActionEnvelopeV1 } from "../../session/reviewProtocol";
import { ReviewApiError, type ReviewApiClient } from "../transport/apiClient";
import { MAX_STALE_RETRIES, ReviewActionSender, createBrowserClientId } from "./reviewActions";

/** A mirror stand-in whose generation a test moves by hand. */
function createTestMirror(generation: string | undefined) {
  const listeners = new Set<() => void>();
  let address = generation ? { generation, stateRevision: 0 } : undefined;
  return {
    getSnapshot: () => ({ address }) as never,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    move(next: string) {
      address = { generation: next, stateRevision: 0 };
      for (const listener of listeners) listener();
    },
  };
}

/** A client stand-in that answers each post from a script and records the envelopes. */
function createTestClient(answers: Array<"ok" | ReviewApiError>) {
  const sent: HunkReviewActionEnvelopeV1[] = [];
  const client = {
    postAction: async (envelope: HunkReviewActionEnvelopeV1) => {
      sent.push(envelope);
      const answer = answers.shift() ?? "ok";
      if (answer !== "ok") throw answer;
      return { ok: true, generation: envelope.generation, stateRevision: sent.length };
    },
  } as unknown as ReviewApiClient;
  return { client, sent };
}

const STALE = () => new ReviewApiError("stale-generation", "stale");
const ACTION = { type: "notes/set-visibility", visible: false } as const;

describe("ReviewActionSender", () => {
  test("sends the shown generation, the precondition, and a browser actor", async () => {
    const { client, sent } = createTestClient(["ok"]);
    const sender = new ReviewActionSender({
      client,
      mirror: createTestMirror("g1"),
      clientId: "tab",
    });
    const outcome = await sender.send(ACTION, { expectedStateRevision: 4 });

    expect(outcome).toEqual({
      ok: true,
      applied: { ok: true, generation: "g1", stateRevision: 1 },
    });
    expect(sent[0]).toMatchObject({
      generation: "g1",
      expectedStateRevision: 4,
      actor: { clientId: "tab", kind: "browser" },
      action: ACTION,
    });
  });

  test("words a refusal with the shared catalog", async () => {
    const { client } = createTestClient([new ReviewApiError("too-many-notes", "full")]);
    const sender = new ReviewActionSender({ client, mirror: createTestMirror("g1") });
    expect(await sender.send(ACTION)).toEqual({
      ok: false,
      code: "too-many-notes",
      message: reviewErrorMessage("too-many-notes"),
    });
  });

  test("retries a stale generation once the page shows the newer one", async () => {
    const mirror = createTestMirror("g1");
    const { client, sent } = createTestClient([STALE(), "ok"]);
    const sender = new ReviewActionSender({ client, mirror });
    const pending = sender.send(ACTION);
    await Promise.resolve();
    mirror.move("g2");

    expect((await pending).ok).toBe(true);
    expect(sent.map((envelope) => envelope.generation)).toEqual(["g1", "g2"]);
  });

  test("reports a stale generation when the action no longer means anything", async () => {
    const mirror = createTestMirror("g1");
    const { client, sent } = createTestClient([STALE()]);
    const sender = new ReviewActionSender({ client, mirror });
    const pending = sender.send(ACTION, { stillMeaningful: () => false });
    await Promise.resolve();
    mirror.move("g2");

    expect(await pending).toMatchObject({ ok: false, code: "stale-generation" });
    expect(sent).toHaveLength(1);
  });

  test("stops after the bounded number of retries", async () => {
    const mirror = createTestMirror("g0");
    const { client, sent } = createTestClient(Array.from({ length: MAX_STALE_RETRIES + 1 }, STALE));
    const sender = new ReviewActionSender({ client, mirror });
    const pending = sender.send(ACTION);
    for (let index = 1; index <= MAX_STALE_RETRIES; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      mirror.move(`g${index}`);
    }

    expect(await pending).toMatchObject({ ok: false, code: "stale-generation" });
    expect(sent).toHaveLength(MAX_STALE_RETRIES + 1);
  });

  test("refuses to send before any review is shown", async () => {
    const { client, sent } = createTestClient([]);
    const sender = new ReviewActionSender({ client, mirror: createTestMirror(undefined) });
    expect(await sender.send(ACTION)).toMatchObject({ ok: false, code: "no-publication" });
    expect(sent).toHaveLength(0);
  });

  test("gives every tab its own random client id", () => {
    expect(createBrowserClientId()).toMatch(/^browser-[0-9a-f]{24}$/);
    expect(createBrowserClientId()).not.toBe(createBrowserClientId());
  });
});
