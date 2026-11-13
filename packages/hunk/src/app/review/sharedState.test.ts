import { describe, expect, test } from "bun:test";
import type { AppBootstrap } from "../../core/bootstrap";
import type { DiffFile } from "../../core/changeset/model";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import {
  parseReviewSharedState,
  REVIEW_SHARED_STATE_CURRENT_RESOURCE_ID,
  reviewSharedStateResourceId,
} from "../../session/reviewSharedState";
import { ReviewProducer } from "./producer";
import { ReviewSessionHost } from "./reviewSessionHost";
import { buildReviewPresentationDefaults, buildReviewSharedState } from "./sharedState";

/** Build a one-hunk file whose new line 8 changed, optionally carrying sidecar notes. */
function createTestSharedFile(id: string, agent: DiffFile["agent"] = null) {
  const before = Array.from({ length: 12 }, (_unused, index) => `const v${index + 1} = ${index};`);
  const after = [...before];
  after[7] = "const v8 = 800;";
  return createTestDiffFile({
    after: lines(...after),
    before: lines(...before),
    context: 3,
    id,
    path: `${id}.ts`,
    agent,
  });
}

/** A minimal bootstrap for presentation defaults. */
function createTestSharedBootstrap(
  files: DiffFile[],
  overrides: Partial<AppBootstrap> = {},
): AppBootstrap {
  return {
    input: { kind: "vcs", staged: false, options: {} },
    changeset: { id: "c", title: "working tree", sourceLabel: "/repo", files },
    initialMode: "split",
    reloadContext: { cwd: "/repo" },
    ...overrides,
  };
}

const sidecar: DiffFile["agent"] = {
  path: "alpha.ts",
  summary: "alpha summary",
  annotations: [{ newRange: [8, 8], summary: "Sidecar note", source: "ai" }],
};

describe("buildReviewSharedState", () => {
  test("lists sidecar then stored notes per file, with marks and the agent reveal by file key", () => {
    const files = [createTestSharedFile("alpha", sidecar), createTestSharedFile("beta")];
    const host = new ReviewSessionHost({ files, sourceLabel: "/repo", now: () => 1 });
    host.addLiveComment({ filePath: "beta.ts", hunkIndex: 0, summary: "Live" }, "mcp:1");
    host.startUserNote({ fileId: "alpha", hunkIndex: 0 });
    host.updateDraftNote("Mine");
    host.saveDraftNote();
    host.addAgentLineHighlight({ filePath: "beta.ts", side: "new", line: 8, start: 0, end: 5 });
    host.navigateToLocation({ filePath: "beta.ts", side: "new", line: 8 });

    const presentation = buildReviewPresentationDefaults(createTestSharedBootstrap(files));
    const state = buildReviewSharedState(host, { generation: "generation:p1:0", presentation });
    const alphaKey = host.fileKeyFor("alpha")!;
    const betaKey = host.fileKeyFor("beta")!;

    expect(state.files.map((file) => [file.key, file.path, file.agentSummary])).toEqual([
      [alphaKey, "alpha.ts", "alpha summary"],
      [betaKey, "beta.ts", undefined],
    ]);
    expect(state.notes.map((entry) => [entry.origin, entry.note.id, entry.note.fileKey])).toEqual([
      ["sidecar", `ai:${alphaKey}:0`, alphaKey],
      ["user", "user:1-1", alphaKey],
      ["live", "mcp:1", betaKey],
    ]);
    expect(state.notes[0]!.note).toMatchObject({ source: "ai", editable: false });
    expect(state.agentHighlights).toEqual({
      [betaKey]: [{ side: "new", line: 8, start: 0, end: 5, tone: "match" }],
    });
    expect(state.agentReveal).toEqual({
      token: 1,
      fileKey: betaKey,
      hunkIndex: 0,
      side: "new",
      line: 8,
    });
    // The JSON form round-trips through the browser-safe parser exactly.
    const wire = JSON.parse(JSON.stringify(state));
    expect(parseReviewSharedState(wire)).toEqual(wire);
  });

  test("advances the shared revision for shared content and never for selection", () => {
    const files = [createTestSharedFile("alpha"), createTestSharedFile("beta")];
    const host = new ReviewSessionHost({ files });
    const start = host.getSharedStateRevision();

    host.selectHunk("beta", 0);
    host.anchorSelection("alpha", 0);
    host.toggleAgentNotes();
    const afterVisibility = host.getSharedStateRevision();
    expect(afterVisibility).toBeGreaterThan(start);
    host.selectFile("beta");
    expect(host.getSharedStateRevision()).toBe(afterVisibility);

    host.setFilter("beta");
    host.addAgentLineHighlight({ filePath: "beta.ts", side: "new", line: 8, start: 0, end: 1 });
    host.addLiveComment({ filePath: "alpha.ts", hunkIndex: 0, summary: "focus" }, "mcp:f", {
      reveal: true,
    });
    expect(host.getSharedStateRevision()).toBeGreaterThan(afterVisibility + 3);
    expect(host.getAgentReveal()).toMatchObject({ noteId: "mcp:f", hunkIndex: 0 });
  });
});

describe("buildReviewPresentationDefaults", () => {
  test("names a built-in theme by id and folds keybindings over the review commands", () => {
    const defaults = buildReviewPresentationDefaults(
      createTestSharedBootstrap([], {
        initialTheme: "github-dark-default",
        initialWrapLines: true,
        keybindings: { "hunk.app.quit": "ctrl+q" },
      }),
    );
    expect(defaults.theme).toEqual({
      kind: "builtin",
      id: "github-dark-default",
      appearance: "dark",
    });
    expect(defaults.view).toEqual({
      layout: "split",
      wrapLines: true,
      lineNumbers: true,
      hunkHeaders: true,
    });
    expect(defaults.keymap["hunk.app.quit"]).toEqual(["ctrl+q"]);
    expect(defaults.title).toBe("working tree");
  });

  test("carries a custom theme as resolved tokens", () => {
    const defaults = buildReviewPresentationDefaults(
      createTestSharedBootstrap([], {
        initialTheme: "mine",
        customThemes: [{ id: "mine", label: "Mine", base: "github-light-default" }],
      }),
    );
    expect(defaults.theme).toMatchObject({ kind: "custom", id: "mine", label: "Mine" });
    if (defaults.theme.kind !== "custom") throw new Error("expected a custom theme");
    expect(typeof defaults.theme.tokens.background).toBe("string");
    expect(typeof defaults.theme.syntaxColors.keyword).toBe("string");
    expect(defaults.theme.tokens.syntaxColors).toBeUndefined();
  });
});

describe("ReviewProducer shared state", () => {
  test("answers the current alias under the concrete revision and refuses a retired one", async () => {
    const files = [createTestSharedFile("alpha")];
    const host = new ReviewSessionHost({ files, sourceLabel: "/repo" });
    const producer = new ReviewProducer({ files, sourceLabel: "/repo" }, { producerId: "t" });
    const presentation = buildReviewPresentationDefaults(createTestSharedBootstrap(files));
    producer.attachStore(host.store, {
      getSharedStateRevision: () => host.getSharedStateRevision(),
      build: (generation) => buildReviewSharedState(host, { generation, presentation }),
    });
    const generation = producer.getPublication().generation;

    const current = await producer.readResource({
      generation,
      resourceId: REVIEW_SHARED_STATE_CURRENT_RESOURCE_ID,
      offset: 0,
      length: 1024 * 64,
    });
    expect(current.ok && current.chunk.resourceId).toBe(
      reviewSharedStateResourceId(host.getSharedStateRevision()),
    );

    host.setFilter("alpha");
    host.setFilter("");
    host.setFilter("x");
    host.setFilter("y");
    host.setFilter("z");
    const retired = await producer.readResource({
      generation,
      resourceId: reviewSharedStateResourceId(host.getSharedStateRevision() + 5),
      offset: 0,
      length: 16,
    });
    expect(retired).toMatchObject({ ok: false, code: "unknown-resource" });
  });
});
