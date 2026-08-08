import { describe, expect, test } from "bun:test";
import { TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { resolveTheme } from "../../themes";
import {
  AgentInlineNote,
  draftVisualLineCount,
  measureAgentInlineNoteHeight,
} from "./AgentInlineNote";

const theme = resolveTheme("github-dark-default", null);

describe("draftVisualLineCount", () => {
  const cases: Array<[string, string, number, number]> = [
    // [label, text, width, expected rows]
    ["empty text", "", 10, 1],
    ["short ASCII fits", "hello", 10, 1],
    ["ASCII exact fit", "aaaaaaaaaa", 10, 1],
    ["ASCII one cell over", "aaaaaaaaaaa", 10, 2],
    ["long unbroken ASCII", "a".repeat(50), 10, 5],
    ["word slack packs by cells", "aaaaaa aaaaaa aaaaaa", 10, 2],
    ["trailing space counts", "aaaaaaaaaa ", 10, 2],
    ["spaces only", "   ", 10, 1],
    ["CJK exact fit", "阿斯蒂芬加", 10, 1],
    ["CJK one cluster over", "阿斯蒂芬加快", 10, 2],
    ["long unbroken CJK", "阿".repeat(25), 10, 5],
    ["wide clusters cannot straddle an odd width", "阿".repeat(25), 25, 3],
    ["CJK punctuation", "你好,世界。你好!", 10, 2],
    ["combining marks stay attached", "e\u0301".repeat(8), 10, 1],
    ["combining mark at the boundary", "a".repeat(10) + "e\u0301", 10, 2],
    ["ZWJ emoji cluster", "👨‍👩‍👧".repeat(6), 10, 2],
    ["mixed ASCII and CJK", "ab阿cd", 10, 1],
    ["emoji run", "🎉".repeat(8), 10, 2],
    ["mixed emoji", "ab🎉cd🎉ef", 6, 2],
    ["realistic CJK prose", "这个包主要是为了在普通的chatmodel外面包一层?", 20, 3],
    ["hard newline", "aaa\nbbb", 10, 2],
    ["trailing newline", "aaa\n", 10, 2],
    ["empty middle line", "aaa\n\nbbb", 10, 3],
    ["newline plus wrap", "aaaaaaaaaaa\nbbb", 10, 3],
    ["tab is two cells", "a\tb", 3, 2],
    ["tab fits wider box", "a\tb", 4, 1],
    ["tab after content", "aaaaaaaa\taa", 10, 2],
    ["emoji flag with combining mark", "HEAD-" + "🇺🇸\u0301".repeat(10) + "-TAIL", 24, 2],
    ["bare heart emoji", "❤".repeat(13), 24, 2],
    ["width clamps to one", "ab", 0, 2],
  ];

  for (const [label, text, width, expected] of cases) {
    test(label, () => {
      expect(draftVisualLineCount(text, width)).toBe(expected);
    });
  }
});

describe("draftVisualLineCount editor parity", () => {
  const parityTexts = [
    "",
    "hello world",
    "a".repeat(10),
    "a".repeat(50),
    "hello world this is a longer line with spaces to wrap properly ok",
    "aaaaaa aaaaaa aaaaaa",
    "阿斯蒂芬加",
    "阿斯蒂芬加快",
    "阿".repeat(25),
    "你好,世界。你好!",
    "这个包主要是为了在普通的chatmodel外面包一层?",
    "ab阿cd🎉ef",
    "🎉".repeat(8),
    "e\u0301".repeat(12),
    "a".repeat(10) + "e\u0301",
    "👨‍👩‍👧".repeat(6),
    "HEAD-" + "🇺🇸\u0301".repeat(10) + "-TAIL",
    "❤".repeat(13),
    "a  b   c",
    "aaaaaaaaaa ",
    "aaa\nbbb",
    "aaa\n",
    "aaa\n\nbbb",
    "a\tb",
    "aaaaaaaa\taa",
  ];

  for (const width of [24, 25, 40, 72]) {
    test(`matches the real editor wrap count at width ${width}`, async () => {
      const { renderer, renderOnce } = await createTestRenderer({ width: 120, height: 60 });
      const textarea = new TextareaRenderable(renderer, { width, height: 40, wrapMode: "char" });
      renderer.root.add(textarea);
      await renderOnce();

      try {
        for (const text of parityTexts) {
          textarea.setText(text);
          await renderOnce();
          expect(textarea.virtualLineCount).toBe(draftVisualLineCount(text, width));
        }
      } finally {
        await renderer.destroy();
      }
    });
  }
});

function draftAnnotation(body: string) {
  return {
    id: "draft:1",
    source: "user-draft" as const,
    summary: body || " ",
    newRange: [1, 1] as [number, number],
    editable: true,
  };
}

function DraftHarness({ width }: { width: number }) {
  const [body, setBody] = useState("");
  return (
    <AgentInlineNote
      annotation={draftAnnotation(body)}
      anchorSide="new"
      layout="split"
      theme={theme}
      width={width}
      draft={{
        body,
        focused: true,
        onInput: setBody,
        onCancel: () => {},
        onSave: () => {},
      }}
    />
  );
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Count the rendered card rows from its top border to the footer bottom border. */
function renderedCardRowCount(frame: string) {
  const lines = frame.split("\n");
  const top = lines.findIndex((line) => line.includes("╭─"));
  const bottom = lines.reduce((last, line, index) => (line.includes("┴") ? index : last), -1);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(bottom).toBeGreaterThan(top);
  return bottom - top + 1;
}

function plannedCardHeight(body: string, width: number, layout: "split" | "stack" = "split") {
  return measureAgentInlineNoteHeight({
    annotation: draftAnnotation(body),
    anchorSide: "new",
    layout,
    width,
  });
}

describe("AgentInlineNote draft composer", () => {
  test("renders long CJK drafts fully wrapped with nothing scrolled away", async () => {
    // 60 distinct wide characters, 120 cells.
    const body =
      "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈";
    const setup = await testRender(
      <AgentInlineNote
        annotation={draftAnnotation(body)}
        anchorSide="new"
        layout="split"
        theme={theme}
        width={96}
        draft={{
          body,
          focused: true,
          onInput: () => {},
          onCancel: () => {},
          onSave: () => {},
        }}
      />,
      { width: 120, height: 40 },
    );

    try {
      await flush(setup);
      const frame = setup.captureCharFrame();
      expect(frame).toContain(body.slice(0, 10));
      expect(frame).toContain(body.slice(-4));
      expect(renderedCardRowCount(frame)).toBe(plannedCardHeight(body, 96));
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("keeps every typed CJK character visible while the text wraps", async () => {
    const setup = await testRender(<DraftHarness width={96} />, { width: 120, height: 40 });

    try {
      await flush(setup);
      // 31 distinct wide characters, 62 cells: wraps well before the last keystroke.
      const chars = [..."一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥完"];

      let typed = "";
      for (const char of chars) {
        typed += char;
        await act(async () => {
          await setup.mockInput.typeText(char);
        });
        await flush(setup);
      }

      const frame = setup.captureCharFrame();
      expect(frame).toContain(typed.slice(0, 10));
      expect(frame).toContain(typed.slice(-10));
      expect(renderedCardRowCount(frame)).toBe(plannedCardHeight(typed, 96));
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("renders drafts with clusters that JS width tables mismeasure", async () => {
    // 30 cells by the editor's native width tables; JS tables count 20.
    const body = "HEAD-" + "🇺🇸\u0301".repeat(10) + "-TAIL";
    const setup = await testRender(
      <AgentInlineNote
        annotation={draftAnnotation(body)}
        anchorSide="new"
        layout="stack"
        theme={theme}
        width={34}
        draft={{
          body,
          focused: true,
          onInput: () => {},
          onCancel: () => {},
          onSave: () => {},
        }}
      />,
      { width: 60, height: 30 },
    );

    try {
      await flush(setup);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("HEAD-");
      expect(frame).toContain("TAIL");
      expect(renderedCardRowCount(frame)).toBe(plannedCardHeight(body, 34, "stack"));
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("grows across hard newlines with wide characters before and after", async () => {
    const setup = await testRender(<DraftHarness width={96} />, { width: 120, height: 40 });

    try {
      await flush(setup);
      await act(async () => {
        await setup.mockInput.typeText("第一行内容");
      });
      await flush(setup);
      await act(async () => {
        setup.mockInput.pressEnter();
      });
      await flush(setup);
      await act(async () => {
        await setup.mockInput.typeText("第二行");
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("第一行内容");
      expect(frame).toContain("第二行");
      expect(renderedCardRowCount(frame)).toBe(plannedCardHeight("第一行内容\n第二行", 96));
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("grows to fit a large bracketed paste", async () => {
    const setup = await testRender(<DraftHarness width={96} />, { width: 120, height: 40 });

    try {
      await flush(setup);
      const blob = "pasted 文本内容 mixed english words ".repeat(6) + "END标记";
      await act(async () => {
        await setup.mockInput.pasteBracketedText(blob);
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain(blob.slice(0, 10));
      expect(frame).toContain("标记");
      expect(renderedCardRowCount(frame)).toBe(plannedCardHeight(blob, 96));
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("rendered card height matches the planned height for wide bodies", async () => {
    const bodies = [
      "阿".repeat(60),
      "🎉".repeat(30) + "tail",
      " tabs\tinside\t text ".repeat(4),
      "short\n阿斯蒂芬加快速度发卡号\nend",
      "plain English text that keeps wrapping past one full row of the box",
    ];

    for (const body of bodies) {
      const setup = await testRender(
        <AgentInlineNote
          annotation={draftAnnotation(body)}
          anchorSide="new"
          layout="split"
          theme={theme}
          width={96}
          draft={{
            body,
            focused: true,
            onInput: () => {},
            onCancel: () => {},
            onSave: () => {},
          }}
        />,
        { width: 120, height: 40 },
      );

      try {
        await flush(setup);
        const frame = setup.captureCharFrame();
        expect(renderedCardRowCount(frame)).toBe(plannedCardHeight(body, 96));
      } finally {
        await act(async () => {
          setup.renderer.destroy();
        });
      }
    }
  });
});
