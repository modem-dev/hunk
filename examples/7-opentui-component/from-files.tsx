#!/usr/bin/env bun

import { parseDiffFromFile } from "../../src/opentui";
import { readExampleFile, runExample } from "./support";

const path = "src/reviewSummary.ts";
const before = readExampleFile("before.ts");
const after = readExampleFile("after.ts");
const metadata = parseDiffFromFile(
  {
    cacheKey: "example:before",
    contents: before,
    name: path,
  },
  {
    cacheKey: "example:after",
    contents: after,
    name: path,
  },
  { context: 3 },
  true,
);

await runExample({
  title: "HunkDiffView from file contents",
  subtitle: "Built with parseDiffFromFile. Press Ctrl-C to exit.",
  diff: {
    id: "example:files",
    metadata,
    language: "typescript",
    path,
  },
});
