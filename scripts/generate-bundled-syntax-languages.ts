#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bundledLanguages } from "shiki";

/** Render the checked-in collision list in formatter-stable TypeScript. */
export function renderBundledSyntaxLanguages(): string {
  const ids = Object.keys(bundledLanguages).sort();
  const entries = ids.map((id) => `  ${JSON.stringify(id)},`).join("\n");
  return `/** Language ids bundled by the pinned Pierre release; run bun generate:syntax-languages. */
export const BUNDLED_SYNTAX_LANGUAGE_IDS: ReadonlySet<string> = new Set([\n${entries}\n]);
`;
}

if (import.meta.main) {
  writeFileSync(
    resolve(import.meta.dir, "../src/core/changeset/bundledSyntaxLanguages.generated.ts"),
    renderBundledSyntaxLanguages(),
  );
}
