import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { useEffect, useMemo, useState } from "react";
import { useStartupUpdateNotice } from "../src/ui/hooks/useStartupUpdateNotice";

function NoticeHarness({
  delayMs = 1,
  durationMs = 5,
  enabled = true,
  repeatMs = 10,
  resolver,
  onNoticeText,
}: {
  delayMs?: number;
  durationMs?: number;
  enabled?: boolean;
  repeatMs?: number;
  resolver?: () => Promise<{ key: string; message: string } | null>;
  onNoticeText?: (value: string | null) => void;
}) {
  const noticeText = useStartupUpdateNotice({
    delayMs,
    durationMs,
    enabled,
    repeatMs,
    resolver,
  });

  useEffect(() => {
    onNoticeText?.(noticeText);
  }, [noticeText, onNoticeText]);

  return (
    <box>
      <text>{noticeText ?? ""}</text>
    </box>
  );
}

function ResolverSwapHarness({ onNoticeText }: { onNoticeText?: (value: string | null) => void }) {
  const [useSecondResolver, setUseSecondResolver] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setUseSecondResolver(true);
    }, 5);
    timer.unref?.();

    return () => {
      clearTimeout(timer);
    };
  }, []);

  const resolver = useMemo(
    () => async () =>
      useSecondResolver
        ? { key: "latest:2.0.0", message: "Update available: 2.0.0" }
        : { key: "latest:1.0.0", message: "Update available: 1.0.0" },
    [useSecondResolver],
  );

  return (
    <NoticeHarness
      delayMs={15}
      durationMs={200}
      repeatMs={1_000}
      resolver={resolver}
      onNoticeText={onNoticeText}
    />
  );
}

async function advance(setup: Awaited<ReturnType<typeof testRender>>, ms: number) {
  await act(async () => {
    await Bun.sleep(ms);
    await setup.renderOnce();
  });
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
      <NoticeHarness resolver={resolver} onNoticeText={(value) => seen.push(value)} />,
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
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("restarts cleanly when the resolver identity changes before the first delayed check", async () => {
    const seen: Array<string | null> = [];
    const setup = await testRender(
      <ResolverSwapHarness onNoticeText={(value) => seen.push(value)} />,
      { width: 80, height: 2 },
    );

    try {
      await advance(setup, 0);
      await advance(setup, 10);
      await advance(setup, 20);

      expect(seen).toContain("Update available: 2.0.0");
      expect(seen).not.toContain("Update available: 1.0.0");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
