import { describe, expect, test } from "bun:test";
import { decodeStmlEntities, parseStml, type StmlElement, type StmlText } from "./parse";

function firstElement(markup: string): StmlElement {
  const { nodes } = parseStml(markup);
  const element = nodes.find((node): node is StmlElement => node.type === "element");
  if (!element) {
    throw new Error("expected an element");
  }
  return element;
}

describe("parseStml", () => {
  test("parses nested elements with attributes", () => {
    const el = firstElement('<box border-style="rounded" title="Auth"><text>hi</text></box>');
    expect(el.tag).toBe("box");
    expect(el.attrs["border-style"]).toBe("rounded");
    expect(el.attrs.title).toBe("Auth");
    expect(el.children).toHaveLength(1);
    expect((el.children[0] as StmlElement).tag).toBe("text");
  });

  test("keeps bare text and lone angle brackets as text", () => {
    const { nodes, errors } = parseStml("a < b and 3<4");
    expect(errors).toHaveLength(0);
    expect(nodes).toHaveLength(1);
    expect((nodes[0] as StmlText).value).toBe("a < b and 3<4");
  });

  test("tolerates stray closing tags with an error note", () => {
    const { nodes, errors } = parseStml("hello</box>");
    expect((nodes[0] as StmlText).value).toBe("hello");
    expect(errors[0]).toContain("stray closing tag");
  });

  test("implicitly closes unbalanced tags", () => {
    const { nodes, errors } = parseStml("<box><text>hi</box>");
    expect(errors.some((error) => error.includes("implicitly closed"))).toBe(true);
    expect((nodes[0] as StmlElement).tag).toBe("box");
  });

  test("reports unclosed tags", () => {
    const { errors } = parseStml("<box><text>hi</text>");
    expect(errors.some((error) => error.includes("unclosed tag(s)"))).toBe(true);
  });

  test("treats void tags as childless", () => {
    const el = firstElement("<text>line one<br>line two</text>");
    const brIndex = el.children.findIndex(
      (child) => child.type === "element" && child.tag === "br",
    );
    expect(brIndex).toBeGreaterThan(-1);
  });

  test("takes code content verbatim without nested parsing", () => {
    const el = firstElement("<code>const a = <b>1</b>;</code>");
    expect(el.children).toHaveLength(1);
    expect((el.children[0] as StmlText).value).toBe("const a = <b>1</b>;");
  });

  test("strips terminal control sequences from text and attributes", () => {
    const { nodes } = parseStml('<text fg="\u001b[31mred">danger\u001b[2Jzone</text>');
    const el = nodes[0] as StmlElement;
    expect(el.attrs.fg).toBe("red");
    expect((el.children[0] as StmlText).value).toBe("dangerzone");
  });

  test("ignores comments", () => {
    const { nodes } = parseStml("<!-- hidden -->visible");
    expect((nodes[0] as StmlText).value).toBe("visible");
  });

  test("enforces the node limit without throwing", () => {
    const markup = "<b>x</b>".repeat(50);
    const { errors } = parseStml(markup, { maxNodes: 10 });
    expect(errors.some((error) => error.includes("node limit"))).toBe(true);
  });

  test("enforces the depth limit without throwing", () => {
    const markup = `${"<box>".repeat(40)}hi${"</box>".repeat(40)}`;
    const { errors } = parseStml(markup, { maxDepth: 5 });
    expect(errors.some((error) => error.includes("depth limit"))).toBe(true);
  });
});

describe("decodeStmlEntities", () => {
  test("decodes named and numeric entities", () => {
    expect(decodeStmlEntities("&lt;a&gt; &amp; &#65;&#x42;")).toBe("<a> & AB");
  });

  test("keeps unknown and out-of-range entities literal", () => {
    expect(decodeStmlEntities("&unknown; &#x110000;")).toBe("&unknown; &#x110000;");
  });
});
