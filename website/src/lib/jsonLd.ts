/**
 * Serialize one value for a raw `<script type="application/ld+json">` body.
 *
 * `JSON.stringify` leaves `<` alone, so a payload whose text contained
 * `</script>` would close the element and turn the rest of it into markup.
 * Escaping `<` as its JSON unicode escape keeps the document valid JSON-LD
 * while making that impossible. Structured data is assembled from catalog and
 * comparison text that grows without anyone re-reviewing the escaping.
 */
export function toJsonLdScriptBody(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
