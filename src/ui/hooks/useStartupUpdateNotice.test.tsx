import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createEffect } from "solid-js";
import { useStartupUpdateNotice } from "./useStartupUpdateNotice";

function NoticeHarness(props: {
  delayMs?: number;
  durationMs?: number;
  enabled?: boolean;
  repeatMs?: number;
  resolver?: () => Promise<{ key: string; message: string } | null>;
  onNoticeText?: (value: string | null) => void;
}) {
  const noticeText = useStartupUpdateNotice({
    delayMs: props.delayMs ?? 1,
    durationMs: props.durationMs ?? 5,
    enabled: props.enabled ?? true,
    repeatMs: props.repeatMs ?? 10,
    resolver: props.resolver,
  });

  // Report every notice-text transition so tests can assert the sequence.
  createEffect(() => {
    props.onNoticeText?.(noticeText());
  });

  return (
    <box>
      <text>{noticeText() ?? ""}</text>
    </box>
  );
}

async function advance(setup: Awaited<ReturnType<typeof testRender>>, ms: number) {
  await Bun.sleep(ms);
  await setup.renderOnce();
}

describe("useStartupUpdateNotice", () => {
  test("dedupes the same notice across repeated checks in one session", async () => {
    const seen: Array<string | null> = [];
    let resolveCalls = 0;
    const resolver = async () => {
      resolveCalls += 1;
      return { key: "latest:9.9.9", message: "Update available: 9.9.9" };
    };

    const setup = await testRender(
      () => <NoticeHarness resolver={resolver} onNoticeText={(value) => seen.push(value)} />,
      { width: 80, height: 2 },
    );

    try {
      await advance(setup, 0);
      await advance(setup, 4);
      await advance(setup, 8);
      await advance(setup, 20);

      expect(resolveCalls).toBeGreaterThanOrEqual(2);
      expect(seen.filter((value) => value === "Update available: 9.9.9")).toHaveLength(1);
      expect(seen.includes(null)).toBe(true);
      expect(setup.captureCharFrame()).not.toContain("Update available: 9.9.9");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("shows the resolved notice, then clears it after the duration elapses", async () => {
    const seen: Array<string | null> = [];
    const resolver = async () => ({ key: "latest:1.0.0", message: "Update available: 1.0.0" });

    const setup = await testRender(
      () => (
        <NoticeHarness
          delayMs={1}
          durationMs={20}
          repeatMs={1_000}
          resolver={resolver}
          onNoticeText={(value) => seen.push(value)}
        />
      ),
      { width: 80, height: 2 },
    );

    try {
      await advance(setup, 5);
      expect(seen).toContain("Update available: 1.0.0");
      expect(setup.captureCharFrame()).toContain("Update available: 1.0.0");

      // After the dismiss timer fires the notice should be cleared back to null.
      await advance(setup, 40);
      expect(seen[seen.length - 1]).toBeNull();
      expect(setup.captureCharFrame()).not.toContain("Update available: 1.0.0");
    } finally {
      setup.renderer.destroy();
    }
  });
});
