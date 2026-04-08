#!/usr/bin/env bun

import { parsePatchFiles } from "../../src/opentui";
import { readExampleFile, runExample } from "./support";

const patch = readExampleFile("change.patch");
const parsedPatches = parsePatchFiles(patch, "example:patch", true);
const metadata = parsedPatches.flatMap((entry) => entry.files)[0];

if (!metadata) {
  throw new Error("Expected one diff file in examples/7-opentui-component/change.patch.");
}

await runExample({
  title: "HunkDiffView from patch text",
  subtitle: "Built with parsePatchFiles. Press Ctrl-C to exit.",
  diff: {
    id: "example:patch",
    metadata,
    language: "typescript",
    path: metadata.name,
    patch,
  },
});
