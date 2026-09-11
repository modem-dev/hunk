import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";
import { resolveTheme } from "../themes";
import { StatusLine, statusLineHasContent } from "./StatusLine";
import type { StatusLineSnapshot } from "./types";

async function captureFrame(node: ReactNode, width: number) {
  const setup = await testRender(node, { width, height: 3 });
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    return setup.captureCharFrame();
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

const theme = resolveTheme("github-dark-default", null);
const noop = () => {};

function render(snapshot: StatusLineSnapshot, badge: string | null = null, width = 80) {
  return captureFrame(
    <StatusLine
      badge={badge}
      snapshot={snapshot}
      terminalWidth={width}
      theme={theme}
      onPromptCancel={noop}
      onPromptInput={noop}
      onPromptSubmit={noop}
    />,
    width,
  );
}

function prompt(value: string, attribution: string | null = null) {
  return { id: 1, prefix: "filter:", placeholder: "type to filter files", value, attribution };
}

describe("StatusLine", () => {
  test("renders an open prompt with its prefix and typed value", async () => {
    const frame = await render({ items: [], prompt: prompt("beta") });

    expect(frame).toContain("filter: beta");
  });

  test("renders the placeholder while the prompt is empty", async () => {
    const frame = await render({ items: [], prompt: prompt("") });

    expect(frame).toContain("filter: type to filter files");
  });

  test("paints a third-party prompt's attribution before the prefix", async () => {
    const frame = await render({ items: [], prompt: prompt("x", "ext search") });

    expect(frame).toContain("ext search filter: x");
  });

  test("renders left items, right items, and the badge together", async () => {
    const frame = await render(
      {
        items: [
          { id: "host:filter", spans: [{ text: "filter=beta" }] },
          { id: "host:notice", spans: [{ text: "Update available" }] },
          { id: "ext:count", spans: [{ text: "3 viewed" }], alignment: "right" },
        ],
        prompt: null,
      },
      "Vim navigation — ext vim:normal — Esc exits",
      100,
    );

    expect(frame).toContain("filter=beta  Update available");
    expect(frame).toMatch(/3 viewed\s+Vim navigation/);
  });

  test("a prompt hides left items but keeps the badge", async () => {
    const frame = await render(
      {
        items: [{ id: "host:notice", spans: [{ text: "Update available" }] }],
        prompt: prompt("beta"),
      },
      "Vim navigation",
    );

    expect(frame).toContain("filter: beta");
    expect(frame).not.toContain("Update available");
    expect(frame).toContain("Vim navigation");
  });

  test("the badge click runs the host exit callback and stops the outer click", () => {
    let exits = 0;
    let stopped = 0;
    const element = StatusLine({
      badge: "Vim navigation",
      snapshot: { items: [], prompt: null },
      terminalWidth: 80,
      theme,
      onPromptCancel: noop,
      onPromptInput: noop,
      onPromptSubmit: noop,
      onExitMode: () => {
        exits += 1;
      },
    }) as unknown as {
      props: {
        children: readonly [unknown, unknown, { props: { onMouseUp: (e: unknown) => void } }];
      };
    };

    element.props.children[2].props.onMouseUp({
      stopPropagation() {
        stopped += 1;
      },
    });
    expect(exits).toBe(1);
    expect(stopped).toBe(1);
  });

  test("statusLineHasContent ignores items with empty spans", () => {
    expect(statusLineHasContent({ items: [{ id: "a", spans: [] }], prompt: null }, null)).toBe(
      false,
    );
    expect(
      statusLineHasContent({ items: [{ id: "a", spans: [{ text: "" }] }], prompt: null }, null),
    ).toBe(false);
    expect(
      statusLineHasContent({ items: [{ id: "a", spans: [{ text: "x" }] }], prompt: null }, null),
    ).toBe(true);
    expect(statusLineHasContent({ items: [], prompt: null }, "Mode")).toBe(true);
    expect(statusLineHasContent({ items: [], prompt: prompt("") }, null)).toBe(true);
  });
});
