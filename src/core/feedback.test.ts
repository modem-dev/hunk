import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };
import { buildFeedbackEventPayload, submitFeedback } from "./feedback";

const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");
const FIXED_ISO = FIXED_DATE.toISOString();

describe("buildFeedbackEventPayload", () => {
  test("builds a feedback.created envelope without an author block when no email is given", () => {
    const payload = buildFeedbackEventPayload(
      { description: "It crashed on startup." },
      () => FIXED_DATE,
    );

    expect(payload).toEqual({
      event_type: "feedback.created",
      created_at: FIXED_ISO,
      client: { name: "hunk/cli", version: packageJson.version },
      body: {
        data: {
          source_message_id: expect.any(String),
          content: "It crashed on startup.",
          type: "feedback",
          source: "user",
          metadata: {
            platform: process.platform,
            app_version: packageJson.version,
          },
        },
      },
    });
    expect(payload.body.data).not.toHaveProperty("author");
    expect(payload.body.data).not.toHaveProperty("channel");
    expect(payload).not.toHaveProperty("source_name");
  });

  test("includes an author block scoped to the submitter's email when provided", () => {
    const payload = buildFeedbackEventPayload(
      { description: "Love the split view!", email: "reviewer@example.com" },
      () => FIXED_DATE,
    );

    expect(payload.body.data.author).toEqual({
      source_author_id: "reviewer@example.com",
      email: "reviewer@example.com",
      is_bot: false,
    });
  });

  test("generates a fresh correlation id for every submission", () => {
    const first = buildFeedbackEventPayload({ description: "a" }, () => FIXED_DATE);
    const second = buildFeedbackEventPayload({ description: "b" }, () => FIXED_DATE);

    expect(first.body.data.source_message_id).not.toBe(second.body.data.source_message_id);
  });
});

describe("submitFeedback", () => {
  test("fails with not-configured when the public key is still the shipped placeholder", async () => {
    const result = await submitFeedback(
      { description: "hello" },
      { env: {}, fetchImpl: async () => new Response(null, { status: 202 }) },
    );

    expect(result).toEqual({ ok: false, reason: "not-configured" });
  });

  test("fails with not-configured when the override env var is blank", async () => {
    const result = await submitFeedback(
      { description: "hello" },
      {
        env: { HUNK_MODEM_FEEDBACK_KEY: "   " },
        fetchImpl: async () => new Response(null, { status: 202 }),
      },
    );

    expect(result).toEqual({ ok: false, reason: "not-configured" });
  });

  test("posts the envelope to the configured ingest URL with the public key header", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const result = await submitFeedback(
      { description: "Great tool!", email: "user@example.com" },
      {
        env: {
          HUNK_MODEM_FEEDBACK_KEY: "modem_test_key",
          HUNK_MODEM_INGEST_URL: "https://ingest.example.test",
        },
        fetchImpl: async (input, init) => {
          requests.push({ url: String(input), init });
          return new Response(null, { status: 202 });
        },
        now: () => FIXED_DATE,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://ingest.example.test/ingest");
    expect(requests[0]?.init?.method).toBe("POST");

    const headers = requests[0]?.init?.headers as Record<string, string>;
    expect(headers["x-modem-public-key"]).toBe("modem_test_key");
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.body.data.content).toBe("Great tool!");
    expect(body.body.data.author.email).toBe("user@example.com");
  });

  test("fails with http-error when the ingest endpoint responds with a non-2xx status", async () => {
    const result = await submitFeedback(
      { description: "hello" },
      {
        env: { HUNK_MODEM_FEEDBACK_KEY: "modem_test_key" },
        fetchImpl: async () => new Response(null, { status: 500 }),
      },
    );

    expect(result).toEqual({ ok: false, reason: "http-error" });
  });

  test("fails with network-error and never throws when fetch rejects", async () => {
    const result = await submitFeedback(
      { description: "hello" },
      {
        env: { HUNK_MODEM_FEEDBACK_KEY: "modem_test_key" },
        fetchImpl: async () => {
          throw new Error("boom");
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: "network-error" });
  });
});
