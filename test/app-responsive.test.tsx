import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { parseDiffFromFile } from "@pierre/diffs";
import { act } from "react";
import type { AppBootstrap, DiffFile } from "../src/core/types";

const { App } = await import("../src/ui/App");

function createDiffFile(id: string, path: string, before: string, after: string, withAgent = false): DiffFile {
  const metadata = parseDiffFromFile(
    {
      name: path,
      contents: before,
      cacheKey: `${id}:before`,
    },
    {
      name: path,
      contents: after,
      cacheKey: `${id}:after`,
    },
    { context: 3 },
    true,
  );

  let additions = 0;
  let deletions = 0;
  for (const hunk of metadata.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "change") {
        additions += content.additions;
        deletions += content.deletions;
      }
    }
  }

  return {
    id,
    path,
    patch: "",
    language: "typescript",
    stats: {
      additions,
      deletions,
    },
    metadata,
    agent: withAgent
      ? {
          path,
          summary: `${path} note`,
          annotations: [{ newRange: [2, 2], summary: `Annotation for ${path}` }],
        }
      : null,
  };
}

function createBootstrap(): AppBootstrap {
  return {
    input: {
      kind: "git",
      staged: false,
      options: {
        mode: "auto",
      },
    },
    changeset: {
      id: "changeset:responsive",
      sourceLabel: "repo",
      title: "repo working tree",
      summary: "Patch summary",
      agentSummary: "Changeset summary",
      files: [
        createDiffFile("alpha", "alpha.ts", "export const alpha = 1;\n", "export const alpha = 2;\nexport const add = true;\n", true),
        createDiffFile("beta", "beta.ts", "export const beta = 1;\n", "export const betaValue = 1;\n", false),
      ],
    },
    initialMode: "auto",
    initialTheme: "midnight",
  };
}

async function captureResponsiveFrames() {
  const setup = await testRender(<App bootstrap={createBootstrap()} />, { width: 280, height: 24 });

  try {
    await act(async () => {
      await setup.renderOnce();
    });
    const ultraWide = setup.captureCharFrame();

    await act(async () => {
      setup.resize(220, 24);
      await setup.renderOnce();
    });
    const full = setup.captureCharFrame();

    await act(async () => {
      setup.resize(160, 24);
      await setup.renderOnce();
    });
    const medium = setup.captureCharFrame();

    await act(async () => {
      setup.resize(159, 24);
      await setup.renderOnce();
    });
    const tight = setup.captureCharFrame();

    return { ultraWide, full, medium, tight };
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

describe("responsive shell", () => {
  test("App adjusts the visible panes and diff layout on live resize", async () => {
    const { ultraWide, full, medium, tight } = await captureResponsiveFrames();

    expect(ultraWide).toContain("Files");
    expect(ultraWide).toContain("Changeset summary");

    expect(full).toContain("Files");
    expect(full).not.toContain("Changeset summary");
    expect(full).toContain("drag divider resize");
    expect(full).toContain("│");

    expect(medium).not.toContain("Files");
    expect(medium).not.toContain("Changeset summary");
    expect(medium).toContain("│");
    expect(medium).not.toContain("drag divider resize");

    expect(tight).not.toContain("Files");
    expect(tight).not.toContain("Changeset summary");
    expect(tight).not.toContain("│");
    expect(tight).not.toContain("drag divider resize");
  });
});
