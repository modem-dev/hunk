#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bundledLanguages } from "shiki";

const ids = Object.keys(bundledLanguages).sort();
const output = `/** Language ids bundled by the pinned Pierre release; run bun generate:syntax-languages. */
export const BUNDLED_SYNTAX_LANGUAGE_IDS: ReadonlySet<string> = new Set(
${JSON.stringify(ids, null, 2)},
);
`;

writeFileSync(
  resolve(import.meta.dir, "../src/core/changeset/bundledSyntaxLanguages.generated.ts"),
  output,
);
