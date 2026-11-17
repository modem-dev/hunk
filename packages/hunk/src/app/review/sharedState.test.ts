import { describe, expect, test } from "bun:test";
import type { AppBootstrap } from "../../core/bootstrap";
import type { DiffFile } from "../../core/changeset/model";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import {
  parseReviewSharedState,
  REVIEW_SHARED_STATE_CURRENT_RESOURCE_ID,
  reviewSharedStateResourceId,
} from "../../session/reviewSharedState";
import {
  MAX_PROJECTED_SIDECAR_NOTE_BYTES,
  MAX_PROJECTED_SIDECAR_NOTES,
  MAX_REVIEW_NOTE_BYTES,
  reviewNoteByteLength,
} from "../../core/review/noteSize";
import { APP_COMMAND_CATALOG } from "../../core/run/commandCatalog";
import { DEFAULT_AUTO_SPLIT_MIN_WIDTH } from "../../core/run/commandInputs";
import { CONFIG_REFERENCE_OPTIONS } from "../../core/run/config";
import { DEFAULT_TAB_WIDTH } from "../../core/run/tabWidth";
import { WEB_CONFIG_SUPPORT } from "../../core/run/webConfigSupport";
import {
  WEB_LOCAL_COMMAND_KEY_DEFAULTS,
  WEB_LOCAL_FIXED_COMMAND_NAMES,
} from "../../core/run/webLocalCommandCatalog";
import { parseSessionSnapshot } from "../../session/broker/wire";
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

  // Sidecar annotations are launch input: an oversized sidecar must not fail the review or push
  // the snapshot past its bound. The projection keeps the first ones and reports the rest.
  test("omits sidecar annotations past the projected bound and says how many", () => {
    const annotations = Array.from({ length: MAX_PROJECTED_SIDECAR_NOTES + 3 }, (_v, index) => ({
      newRange: [8, 8] as [number, number],
      summary: `Sidecar ${index}`,
      source: "ai" as const,
    }));
    const files = [createTestSharedFile("alpha", { path: "alpha.ts", annotations })];
    const host = new ReviewSessionHost({ files, sourceLabel: "/repo", now: () => 1 });
    const presentation = buildReviewPresentationDefaults(createTestSharedBootstrap(files));
    const state = buildReviewSharedState(host, { generation: "generation:p1:0", presentation });

    // Small notes hit the byte bound before the count bound; either way the kept notes are a
    // prefix and the omitted count accounts for every other one.
    const kept = state.notes.length;
    expect(kept).toBeLessThanOrEqual(MAX_PROJECTED_SIDECAR_NOTES);
    expect(kept + state.omittedSidecarNotes!).toBe(annotations.length);
    expect(state.notes.at(-1)!.note.summary).toBe(`Sidecar ${kept - 1}`);
    expect(
      state.notes.reduce((sum, entry) => sum + reviewNoteByteLength(entry.note), 0),
    ).toBeLessThanOrEqual(MAX_PROJECTED_SIDECAR_NOTE_BYTES);
    const wire = JSON.parse(JSON.stringify(state));
    expect(parseReviewSharedState(wire)).toEqual(wire);
    expect(parseReviewSharedState({ ...wire, omittedSidecarNotes: 0 })).toBeUndefined();
    // The session snapshot omits the same tail, so the daemon keeps accepting it.
    expect(host.getReviewNoteSummaries()).toHaveLength(MAX_PROJECTED_SIDECAR_NOTES);
  });

  // The session snapshot's sidecar summaries were bounded by count alone, so a few large
  // annotations could push the frame past the websocket bound. They now share the byte and
  // per-note bounds, and the snapshot that carries them parses.
  test("bounds the snapshot's sidecar summaries by bytes and by the per-note bound", () => {
    const large = (index: number) => ({
      newRange: [8, 8] as [number, number],
      summary: `Large ${index} ${"x".repeat(200 * 1024)}`,
      source: "ai" as const,
    });
    const files = [
      createTestSharedFile("alpha", {
        path: "alpha.ts",
        annotations: Array.from({ length: 12 }, (_v, index) => large(index)),
      }),
    ];
    const host = new ReviewSessionHost({ files, sourceLabel: "/repo", now: () => 1 });
    const summaries = host.getReviewNoteSummaries();
    const bytes = summaries.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.length).toBeLessThan(12);
    expect(bytes).toBeLessThanOrEqual(MAX_PROJECTED_SIDECAR_NOTE_BYTES);
    expect(summaries.map((entry) => entry.body.slice(0, 8))).toEqual(
      summaries.map((_entry, index) => `Large ${index} `.slice(0, 8)),
    );
    expect(
      parseSessionSnapshot({
        updatedAt: "2026-03-22T00:00:00.000Z",
        state: {
          selectedHunkIndex: 0,
          showAgentNotes: true,
          liveComments: [],
          reviewNoteCount: summaries.length,
          reviewNotes: JSON.parse(JSON.stringify(summaries)),
        },
      }),
    ).not.toBeNull();

    // One annotation larger than a whole note closes the projection rather than disconnecting
    // the session, in both projections.
    const oversized = [
      createTestSharedFile("alpha", {
        path: "alpha.ts",
        annotations: [{ ...large(0), summary: "y".repeat(MAX_REVIEW_NOTE_BYTES) }, large(1)],
      }),
    ];
    const oversizedHost = new ReviewSessionHost({ files: oversized, sourceLabel: "/repo" });
    expect(oversizedHost.getReviewNoteSummaries()).toEqual([]);
    const presentation = buildReviewPresentationDefaults(createTestSharedBootstrap(oversized));
    const state = buildReviewSharedState(oversizedHost, {
      generation: "generation:p1:0",
      presentation,
    });
    expect(state.notes).toEqual([]);
    expect(state.omittedSidecarNotes).toBe(2);
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
      tabWidth: DEFAULT_TAB_WIDTH,
      autoSplitMinWidth: DEFAULT_AUTO_SPLIT_MIN_WIDTH,
      sidebar: "auto",
    });
    expect(defaults.keymap["hunk.app.quit"]).toEqual(["ctrl+q"]);
    expect(defaults.title).toBe("working tree");
  });

  test("publishes the page's own remappable commands with the chords they ship with", () => {
    const { keymap } = buildReviewPresentationDefaults(createTestSharedBootstrap([]));

    for (const command of WEB_LOCAL_COMMAND_KEY_DEFAULTS) {
      expect([command.id, keymap[command.id]]).toEqual([command.id, [...command.defaultKeys]]);
    }
    // The Ctrl/Cmd dialog chords are the page's to match and are not part of the keymap.
    for (const id of WEB_LOCAL_FIXED_COMMAND_NAMES) expect(id in keymap).toBe(false);
    for (const entry of APP_COMMAND_CATALOG) {
      expect(keymap[entry.id]).toEqual([...entry.defaultKeys]);
    }
  });

  // Intent: a `[keybindings]` entry for a page-only command reaches the page as that command's
  // whole binding, so the page stops answering to the default it would otherwise fall back to.
  test("folds a remap, an unbind, and a first binding of page commands into the keymap", () => {
    const { keymap } = buildReviewPresentationDefaults(
      createTestSharedBootstrap([], {
        keybindings: {
          "hunk.web.toggleViewed": "x",
          "hunk.web.toggleSidePanel": false,
          "hunk.web.toggleMinimap": ["M", "ctrl+m"],
        },
      }),
    );

    expect(keymap["hunk.web.toggleViewed"]).toEqual(["x"]);
    expect(keymap["hunk.web.toggleSidePanel"]).toEqual([]);
    expect(keymap["hunk.web.toggleMinimap"]).toEqual(["M", "ctrl+m"]);
    expect(keymap["hunk.web.showOverview"]).toEqual(["O"]);
  });

  // Intent: on the page one key does one thing. A key the user gives a page command is taken
  // from the catalog command that held it by default, and the reverse, in either spelling.
  test("keeps a bound chord exclusive between page commands and catalog commands", () => {
    const pageTakesCatalogKey = buildReviewPresentationDefaults(
      createTestSharedBootstrap([], { keybindings: { "hunk.web.toggleViewed": "w" } }),
    ).keymap;
    expect(pageTakesCatalogKey["hunk.web.toggleViewed"]).toEqual(["w"]);
    expect(pageTakesCatalogKey["hunk.view.toggleLineWrap"]).toEqual([]);

    const catalogTakesPageKey = buildReviewPresentationDefaults(
      createTestSharedBootstrap([], {
        keybindings: { "hunk.review.nextHunk": "p", "hunk.review.previousHunk": "shift+v" },
      }),
    ).keymap;
    expect(catalogTakesPageKey["hunk.review.nextHunk"]).toEqual(["p"]);
    expect(catalogTakesPageKey["hunk.web.toggleSidePanel"]).toEqual([]);
    expect(catalogTakesPageKey["hunk.web.toggleViewed"]).toEqual([]);
    expect(catalogTakesPageKey["hunk.web.showOverview"]).toEqual(["O"]);
  });

  test("leaves the Ctrl/Cmd dialog chords out of the keymap when an entry names one", () => {
    const { keymap } = buildReviewPresentationDefaults(
      createTestSharedBootstrap([], {
        keybindings: { "hunk.web.commandPalette": "x", "hunk.web.toggleViewed": "x" },
      }),
    );

    expect("hunk.web.commandPalette" in keymap).toBe(false);
    // The ignored entry claimed nothing, so the next entry gets the chord.
    expect(keymap["hunk.web.toggleViewed"]).toEqual(["x"]);
  });

  test("publishes tab width, the auto-split width, and the sidebar as the launch resolved them", () => {
    const defaults = buildReviewPresentationDefaults(
      createTestSharedBootstrap([], {
        input: { kind: "vcs", staged: false, options: { autoSplitMinWidth: 120 } },
        initialTabWidth: 8,
        initialSidebar: true,
      }),
    );

    expect(defaults.view).toMatchObject({ tabWidth: 8, autoSplitMinWidth: 120, sidebar: true });
    for (const sidebar of [false, "auto"] as const) {
      expect(
        buildReviewPresentationDefaults(createTestSharedBootstrap([], { initialSidebar: sidebar }))
          .view.sidebar,
      ).toBe(sidebar);
    }
  });

  test("falls back to the terminal's built-in defaults when the bootstrap leaves them unset", () => {
    const { view } = buildReviewPresentationDefaults(createTestSharedBootstrap([]));

    expect(view.tabWidth).toBe(DEFAULT_TAB_WIDTH);
    expect(view.autoSplitMinWidth).toBe(DEFAULT_AUTO_SPLIT_MIN_WIDTH);
    expect(view.sidebar).toBe("auto");
  });

  // Intent: the terminal opens a pager session with the files pane closed whatever `sidebar`
  // says, so a page attached to that session starts the same way.
  test("starts a pager session's sidebar closed", () => {
    const { view } = buildReviewPresentationDefaults(
      createTestSharedBootstrap([], {
        input: { kind: "vcs", staged: false, options: { pager: true } },
        initialSidebar: true,
      }),
    );

    expect(view.sidebar).toBe(false);
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

// Intent: every option classified `published` reaches the page, and nothing reaches the page
// that no option accounts for, so adding a view default means classifying the option behind it.
describe("WEB_CONFIG_SUPPORT against the published presentation defaults", () => {
  const presentation = buildReviewPresentationDefaults(createTestSharedBootstrap([]));
  const sentFields = [
    "theme",
    ...Object.keys(presentation.view).map((field) => `view.${field}`),
  ].sort();
  const publishedFields: string[] = Object.values(WEB_CONFIG_SUPPORT).flatMap((support) =>
    support.kind === "published" ? [support.field] : [],
  );

  test("every published option names a field the host sends", () => {
    const unsent = publishedFields.filter((field) => !sentFields.includes(field));
    expect(unsent).toEqual([]);
  });

  test("every field the host sends is accounted for by exactly one published option", () => {
    expect([...publishedFields].sort()).toEqual(sentFields);
  });

  test("the presentation block sends nothing config-derived beyond the theme and view", () => {
    expect(Object.keys(presentation).sort()).toEqual([
      "keymap",
      "sourceLabel",
      "theme",
      "title",
      "view",
    ]);
  });

  test("each published value follows the option it is classified from", () => {
    const configured = buildReviewPresentationDefaults(
      createTestSharedBootstrap([], {
        input: { kind: "vcs", staged: false, options: { autoSplitMinWidth: 99 } },
        initialMode: "unified",
        initialTheme: "github-light-default",
        initialWrapLines: true,
        initialShowLineNumbers: false,
        initialShowHunkHeaders: false,
        initialTabWidth: 7,
        initialSidebar: false,
      }),
    );
    const view = configured.view as unknown as Record<string, unknown>;
    const expectedByKey: Partial<Record<keyof typeof WEB_CONFIG_SUPPORT, unknown>> = {
      mode: "unified",
      wrap_lines: true,
      line_numbers: false,
      hunk_headers: false,
      tab_width: 7,
      auto_split_min_width: 99,
      sidebar: false,
    };
    for (const option of CONFIG_REFERENCE_OPTIONS) {
      const support = WEB_CONFIG_SUPPORT[option.key];
      if (support.kind !== "published" || support.field === "theme") continue;
      const sent = view[support.field.slice("view.".length)];
      expect([option.key, sent]).toEqual([option.key, expectedByKey[option.key]]);
    }
    expect(configured.theme).toMatchObject({ id: "github-light-default" });
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
