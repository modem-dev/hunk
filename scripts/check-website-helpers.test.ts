import { describe, expect, test } from "bun:test";
import { withInlineCode, withoutInlineCode } from "../website/src/lib/inlineCode";
import { toJsonLdScriptBody } from "../website/src/lib/jsonLd";

/**
 * The hunk.dev helpers that turn stored text into markup.
 *
 * Both are used with `set:html` or inside a raw `<script>` body, so a mistake
 * here is an injection rather than a typo. The catalogs they render are
 * hand-written today and will be generated later, which is exactly when nobody
 * is re-reading the escaping.
 */
describe("JSON-LD serialization", () => {
  test("neutralizes markup", () => {
    const body = toJsonLdScriptBody({ name: "</script><img src=x onerror=alert(1)>" });

    // Nothing can close the script element, and the payload is still JSON-LD.
    expect(body).not.toContain("<");
    expect(JSON.parse(body)).toEqual({ name: "</script><img src=x onerror=alert(1)>" });
  });
});

describe("inline code rendering", () => {
  test("promotes backtick spans to code elements", () => {
    expect(withInlineCode("Run `hunk diff` first.")).toBe("Run <code>hunk diff</code> first.");
    expect(withInlineCode("`a` then `b`")).toBe("<code>a</code> then <code>b</code>");
  });

  test("escapes markup before adding any of its own", () => {
    const rendered = withInlineCode('<img src=x onerror=alert(1)> & "quoted"');

    expect(rendered).not.toContain("<img");
    expect(rendered).toBe("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;");
  });

  test("cannot be tricked into emitting an element from inside a code span", () => {
    // The escape runs first, so a backtick span can only ever contain text.
    expect(withInlineCode("`<b>bold</b>`")).toBe("<code>&lt;b&gt;bold&lt;/b&gt;</code>");
  });

  test("leaves an unpaired backtick alone rather than opening an element", () => {
    expect(withInlineCode("a ` b")).toBe("a ` b");
  });

  test("strips backticks for contexts that take plain text", () => {
    expect(withoutInlineCode("Set `core.pager` to `hunk pager`.")).toBe(
      "Set core.pager to hunk pager.",
    );
  });
});
