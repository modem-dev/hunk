import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { THEMES } from "../themes";
import { DocumentPane } from "./DocumentPane";
import { completeDocumentGeometry, completeDocumentLines } from "./geometry";

/** Flush native layout and viewport notifications without depending on syntax arrival. */
async function flushTestDocumentLayout(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(30);
  });
  await act(async () => {
    await setup.renderOnce();
  });
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

/** Build identifiable, long source lines for deep logical anchoring tests. */
function createTestDocumentText(count = 300, suffix = "x".repeat(90)) {
  return Array.from(
    { length: count },
    (_, index) => `LINE_${String(index + 1).padStart(3, "0")} ${suffix}`,
  ).join("\n");
}

/** Mount a stateful pane so tests exercise React commits followed by real native layout. */
async function createTestDocumentPane(wrap = false, text = createTestDocumentText()) {
  const scrollRef = { current: null as ScrollBoxRenderable | null };
  const visibleLineRef = { current: () => 1 };
  const initial = { text, wrap, lineNumbers: false, documentKey: "file" };
  let update!: (patch: Partial<typeof initial>) => void;

  function TestDocumentPane() {
    const [options, setOptions] = useState(initial);
    update = (patch) => setOptions((previous) => ({ ...previous, ...patch }));
    return (
      <DocumentPane
        document={{ kind: "text", text: options.text, identity: options.text }}
        documentKey={options.documentKey}
        pathHint="file.txt"
        height={12}
        width={40}
        wrap={options.wrap}
        tabWidth={4}
        theme={THEMES[0]!}
        lineNumbers={options.lineNumbers}
        focused={true}
        scrollRef={scrollRef}
        visibleLineRef={visibleLineRef}
      />
    );
  }

  const setup = await testRender(<TestDocumentPane />, { width: 40, height: 12 });
  await flushTestDocumentLayout(setup);
  return {
    setup,
    scrollRef,
    visibleLineRef,
    update: async (patch: Partial<typeof initial>) => {
      await act(async () => update(patch));
    },
    scroll: async (top: number) => {
      await act(async () => scrollRef.current!.scrollTo(top));
      await flushTestDocumentLayout(setup);
    },
    close: async () => {
      await act(async () => setup.renderer.destroy());
    },
  };
}

test("deep wrap toggles wait for new bounds and preserve the source line in both directions", async () => {
  const pane = await createTestDocumentPane();
  try {
    await pane.scroll(250);
    expect(pane.visibleLineRef.current()).toBe(251);
    await act(async () => pane.scrollRef.current!.scrollTo({ x: 40, y: 250 }));
    await pane.update({ wrap: true });
    // React has planned the new rows, but native content bounds still belong to the old plan.
    expect(pane.scrollRef.current!.scrollTop).toBe(250);
    await flushTestDocumentLayout(pane.setup);
    expect(pane.scrollRef.current!.scrollLeft).toBe(0);
    expect(pane.visibleLineRef.current()).toBe(251);
    expect(pane.scrollRef.current!.scrollTop).toBeGreaterThan(288);
    expect(pane.setup.captureCharFrame()).toContain("LINE_251");
    await pane.update({ wrap: false });
    await flushTestDocumentLayout(pane.setup);
    expect(pane.scrollRef.current!.scrollTop).toBe(250);
    expect(pane.visibleLineRef.current()).toBe(251);
  } finally {
    await pane.close();
  }
});

test("shrinking past the visible line clamps to the surviving end rather than the start", async () => {
  const pane = await createTestDocumentPane(true);
  try {
    await pane.scroll(800);
    expect(pane.visibleLineRef.current()).toBe(201);
    await pane.update({ text: createTestDocumentText(100) });
    await flushTestDocumentLayout(pane.setup);
    const scroll = pane.scrollRef.current!;
    expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.viewport.height);
    expect(pane.setup.captureCharFrame()).toContain("LINE_100");
    expect(pane.visibleLineRef.current()).toBeGreaterThan(90);
    await pane.update({ text: "" });
    await flushTestDocumentLayout(pane.setup);
    expect(scroll.scrollTop).toBe(0);
    expect(pane.setup.captureCharFrame()).toContain("Empty file.");
  } finally {
    await pane.close();
  }
});

test("width and line-number changes preserve a logical line and its surviving physical offset", async () => {
  // At 39 cells this is three physical rows; the gutter adds a fourth.
  const pane = await createTestDocumentPane(true, createTestDocumentText(300, "x".repeat(104)));
  try {
    const rows = completeDocumentGeometry(
      completeDocumentLines(createTestDocumentText(300, "x".repeat(104))),
      39,
      false,
      true,
    ).rows;
    await pane.scroll(rows[200]!.start + 1);
    expect(pane.visibleLineRef.current()).toBe(201);
    await pane.update({ lineNumbers: true });
    await flushTestDocumentLayout(pane.setup);
    expect(pane.visibleLineRef.current()).toBe(201);
    expect(pane.scrollRef.current!.scrollTop).toBe(801);
    await act(async () => pane.setup.resize(25, 12));
    await flushTestDocumentLayout(pane.setup);
    expect(pane.visibleLineRef.current()).toBe(201);
    const scroll = pane.scrollRef.current!;
    const geometry = completeDocumentGeometry(
      completeDocumentLines(createTestDocumentText(300, "x".repeat(104))),
      scroll.viewport.width,
      true,
      true,
    );
    expect(scroll.scrollTop).toBe(geometry.rows[200]!.start + 1);
    expect(scroll.scrollHeight).toBe(geometry.totalHeight);
    await act(async () => pane.setup.resize(80, 10));
    await flushTestDocumentLayout(pane.setup);
    expect(pane.visibleLineRef.current()).toBe(201);
    await pane.update({ lineNumbers: false, wrap: false });
    await flushTestDocumentLayout(pane.setup);
    expect(scroll.scrollTop).toBe(200);
    expect(pane.visibleLineRef.current()).toBe(201);
  } finally {
    await pane.close();
  }
});

test("same-document replacement retains the line but switching documents cancels restoration", async () => {
  const pane = await createTestDocumentPane();
  try {
    await pane.scroll(250);
    await pane.update({ text: createTestDocumentText(300, "changed ".repeat(20)), wrap: true });
    await flushTestDocumentLayout(pane.setup);
    expect(pane.visibleLineRef.current()).toBe(251);
    await pane.update({ wrap: false });
    // Switch before native layout has applied the previous pending anchor.
    await pane.update({ documentKey: "other", text: createTestDocumentText(100), wrap: true });
    await flushTestDocumentLayout(pane.setup);
    expect(pane.scrollRef.current!.scrollTop).toBe(0);
    expect(pane.visibleLineRef.current()).toBe(1);
    expect(pane.setup.captureCharFrame()).toContain("LINE_001");
  } finally {
    await pane.close();
  }
});

test("intentional scrolling cancels pending restoration and normal scrolling stays unaffected", async () => {
  const pane = await createTestDocumentPane();
  try {
    await pane.scroll(250);
    await pane.update({ wrap: true });
    // A semantic scroll command issued before new native bounds wins over the old anchor.
    await act(async () => pane.scrollRef.current!.scrollTo(20));
    await flushTestDocumentLayout(pane.setup);
    expect(pane.scrollRef.current!.scrollTop).toBe(20);
    await act(async () => pane.scrollRef.current!.scrollBy(7));
    await flushTestDocumentLayout(pane.setup);
    expect(pane.scrollRef.current!.scrollTop).toBe(27);
    await flushTestDocumentLayout(pane.setup);
    expect(pane.scrollRef.current!.scrollTop).toBe(27);
    await pane.scroll(0);
    expect(pane.visibleLineRef.current()).toBe(1);
  } finally {
    await pane.close();
  }
});
