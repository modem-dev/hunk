import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { THEMES } from "../themes";
import { DocumentPane } from "./DocumentPane";

/** Flush native layout and viewport notifications without depending on syntax arrival. */
async function flushTestDocumentLayout(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(30);
  });
  await setup.renderOnce();
}

test("wrapped documents use the scrollbar-adjusted viewport and retain right-edge characters after resize", async () => {
  const scrollRef = { current: null as ScrollBoxRenderable | null };
  const visibleLineRef = { current: () => 1 };
  const setup = await testRender(
    <DocumentPane
      document={{
        kind: "text",
        text: Array.from({ length: 40 }, () => "1234567890123456789X").join("\n"),
        identity: "stable",
      }}
      documentKey="file"
      pathHint="file.txt"
      height={8}
      width={20}
      wrap={true}
      tabWidth={4}
      theme={THEMES[0]!}
      lineNumbers={false}
      focused={true}
      scrollRef={scrollRef}
      visibleLineRef={visibleLineRef}
    />,
    { width: 20, height: 8 },
  );

  try {
    await flushTestDocumentLayout(setup);
    expect(scrollRef.current?.viewport.width).toBe(19);
    expect(setup.captureCharFrame()).toContain("X");
    expect(scrollRef.current?.scrollLeft).toBe(0);
    await act(async () => setup.resize(19, 8));
    await flushTestDocumentLayout(setup);
    expect(scrollRef.current?.viewport.width).toBe(18);
    expect(setup.captureCharFrame()).toContain("9X");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});
