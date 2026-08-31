import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import type {
  ExtensionChangeset,
  ExtensionDiffFile,
  ExtensionReviewNote,
  ExtensionPaneProps,
  HunkExtensionAPI,
} from "hunkdiff/extension";

type TriageStatus = "approved" | "investigate" | "blocked";

interface TriageDecision {
  status: TriageStatus;
  rationale?: string;
}

interface TriageSnapshot {
  decisions: ReadonlyMap<string, TriageDecision>;
  viewed: ReadonlySet<string>;
  noteCounts: ReadonlyMap<string, number>;
  current: { fileId: string; hunkIndex: number } | null;
  focus: string;
  filter: string;
  reloadPending: boolean;
}

const initialSnapshot: TriageSnapshot = {
  decisions: new Map(),
  viewed: new Set(),
  noteCounts: new Map(),
  current: null,
  focus: "",
  filter: "",
  reloadPending: false,
};

let snapshot = initialSnapshot;
const listeners = new Set<() => void>();

/** Build the stable, session-local key for a parsed hunk. */
function hunkKey(fileId: string, hunkIndex: number) {
  return `${fileId}:${hunkIndex}`;
}

/** Publish an immutable store snapshot so a closed pane never loses its state. */
function updateSnapshot(update: (current: TriageSnapshot) => TriageSnapshot) {
  const next = update(snapshot);
  if (next === snapshot) {
    return;
  }

  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Subscribe a mounted pane to lifecycle state gathered outside React. */
function useTriageSnapshot() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

/** Retain decisions only for hunks still present after a load or reload. */
function reconcileChangeset(changeset: ExtensionChangeset) {
  const knownHunks = new Set(
    changeset.files.flatMap((file) =>
      (file.hunks ?? []).map((hunk) => hunkKey(file.id, hunk.index)),
    ),
  );

  updateSnapshot((current) => ({
    ...current,
    decisions: new Map([...current.decisions].filter(([key]) => knownHunks.has(key))),
    viewed: new Set([...current.viewed].filter((key) => knownHunks.has(key))),
    noteCounts: new Map([...current.noteCounts].filter(([key]) => knownHunks.has(key))),
    current:
      current.current && knownHunks.has(hunkKey(current.current.fileId, current.current.hunkIndex))
        ? current.current
        : null,
    reloadPending: false,
  }));
}

/** Record that the settled review selection exposed one hunk to the reviewer. */
function markViewed(file: ExtensionDiffFile, hunkIndex: number | null) {
  if (hunkIndex === null) {
    return;
  }

  const key = hunkKey(file.id, hunkIndex);
  updateSnapshot((current) => {
    if (current.viewed.has(key)) {
      return current;
    }
    return { ...current, viewed: new Set(current.viewed).add(key) };
  });
}

/** Add one Hunk-authored inline-note count to the matching hunk, if still visible. */
function recordNote(note: ExtensionReviewNote) {
  const key = hunkKey(note.fileId, note.hunkIndex);
  updateSnapshot((current) => {
    const count = current.noteCounts.get(key) ?? 0;
    return { ...current, noteCounts: new Map(current.noteCounts).set(key, count + 1) };
  });
}

/** Store a reviewer decision made through the extension's command flow. */
function setDecision(fileId: string, hunkIndex: number, decision: TriageDecision) {
  const key = hunkKey(fileId, hunkIndex);
  updateSnapshot((current) => ({
    ...current,
    decisions: new Map(current.decisions).set(key, decision),
  }));
}

/** Drop all session-local decisions without touching Hunk's own review notes. */
function clearDecisions() {
  updateSnapshot((current) => ({ ...current, decisions: new Map() }));
}

/** Render a compact, clickable hunk triage board from public pane props. */
function ReviewTriagePane({
  files,
  selectedFileId,
  selectedHunkIndex,
  theme,
  actions,
}: ExtensionPaneProps): ReactNode {
  const state = useTriageSnapshot();
  const summary = useMemo(() => {
    const total = files.reduce((count, file) => count + (file.hunks?.length ?? 0), 0);
    const decisions = [...state.decisions.values()];
    return {
      total,
      approved: decisions.filter((decision) => decision.status === "approved").length,
      investigate: decisions.filter((decision) => decision.status === "investigate").length,
      blocked: decisions.filter((decision) => decision.status === "blocked").length,
    };
  }, [files, state.decisions]);

  return (
    <scrollbox
      width="100%"
      height="100%"
      focused={false}
      scrollY={true}
      rootOptions={{ backgroundColor: theme.panel }}
      wrapperOptions={{ backgroundColor: theme.panel }}
      viewportOptions={{ backgroundColor: theme.panel }}
      contentOptions={{ backgroundColor: theme.panel }}
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
    >
      <box style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
        <text
          content=" Review triage (session only)"
          style={{ fg: theme.accent, bg: theme.panel }}
        />
        <text
          content={` ${summary.approved}/${summary.total} reviewed · !${summary.investigate} · ×${summary.blocked}`}
          style={{ fg: theme.muted, bg: theme.panel }}
        />
        {state.reloadPending ? (
          <text content=" Reload pending…" style={{ fg: theme.accentMuted, bg: theme.panel }} />
        ) : null}
        {state.focus ? (
          <text content={` Focus: ${state.focus}`} style={{ fg: theme.muted, bg: theme.panel }} />
        ) : null}
        {state.filter ? (
          <text content={` Filter: ${state.filter}`} style={{ fg: theme.muted, bg: theme.panel }} />
        ) : null}
        {files.flatMap((file) => {
          const hunks = file.hunks ?? [];
          return [
            <text
              key={`${file.id}:label`}
              content={` ${file.path} (${hunks.length})`}
              style={{ fg: theme.text, bg: theme.panel }}
              onMouseDown={() => actions.selectFile(file.id)}
            />,
            ...hunks.map((hunk) => {
              const key = hunkKey(file.id, hunk.index);
              const decision = state.decisions.get(key);
              const noteCount = state.noteCounts.get(key) ?? 0;
              const selected = file.id === selectedFileId && hunk.index === selectedHunkIndex;
              const marker = decision
                ? { approved: "✓", investigate: "!", blocked: "×" }[decision.status]
                : state.viewed.has(key)
                  ? "·"
                  : "○";
              const rationale = decision?.rationale ? ` — ${decision.rationale}` : "";
              const notes =
                noteCount > 0 ? ` [${noteCount} note${noteCount === 1 ? "" : "s"}]` : "";

              return (
                <text
                  key={key}
                  content={`   ${marker} hunk ${hunk.index + 1}${notes}${rationale}`}
                  style={{
                    fg:
                      decision?.status === "blocked"
                        ? theme.badgeRemoved
                        : decision?.status === "investigate"
                          ? theme.accent
                          : theme.text,
                    bg: selected ? theme.selectedHunk : theme.panel,
                  }}
                  onMouseDown={() => actions.selectHunk(file.id, hunk.index)}
                />
              );
            }),
          ];
        })}
      </box>
    </scrollbox>
  );
}

/** Register a session-local review board that drives only documented Hunk extension APIs. */
export default function registerReviewTriage(hunk: HunkExtensionAPI) {
  hunk.registerPane({
    id: "triage",
    title: "Review triage",
    placement: "right",
    component: ReviewTriagePane,
  });

  hunk.registerCommand({ id: "toggle", title: "Toggle review triage", key: "y" }, (ctx) =>
    ctx.panes.toggle("triage"),
  );

  hunk.registerCommand({ id: "center", title: "Center current review line" }, (ctx) => {
    if (!ctx.commands.execute("hunk.review.alignCurrentLineCenter")) {
      ctx.notify("Enable the current-line marker before centering it", "warning");
    }
  });

  hunk.registerCommand({ id: "mark", title: "Mark selected hunk…", key: "x" }, async (ctx) => {
    const { file, hunkIndex } = ctx.selection;
    if (!file || hunkIndex === null) {
      ctx.notify("Select a hunk before triaging it", "warning");
      return;
    }

    const selectedStatus = await ctx.dialogs.select({
      title: `Triage ${file.path}, hunk ${hunkIndex + 1}`,
      options: ["approved", "investigate", "blocked"],
    });
    if (selectedStatus === null) {
      return;
    }

    const rationale = await ctx.dialogs.input({
      title: `${selectedStatus}: optional rationale`,
      placeholder: "Why should a reviewer care?",
    });
    if (rationale === null) {
      return;
    }

    const decision = {
      status: selectedStatus as TriageStatus,
      rationale: rationale.trim() || undefined,
    };
    setDecision(file.id, hunkIndex, decision);
    hunk.events.emit("review-triage:decision", {
      fileId: file.id,
      hunkIndex,
      status: decision.status,
    });
    ctx.notify(`Marked hunk ${hunkIndex + 1} ${selectedStatus}`);
  });

  hunk.registerCommand({ id: "focus", title: "Set review focus…" }, async (ctx) => {
    const focus = await ctx.dialogs.input({
      title: "Review focus",
      placeholder: "What are you looking for in this changeset?",
      initial: snapshot.focus,
    });
    if (focus === null) {
      return;
    }
    updateSnapshot((current) => ({ ...current, focus: focus.trim() }));
    ctx.panes.open("triage");
  });

  hunk.registerCommand({ id: "clear", title: "Clear triage decisions" }, async (ctx) => {
    if (
      !(await ctx.dialogs.confirm({
        title: "Clear review triage?",
        body: "This only clears this extension's session-local decisions.",
        confirmLabel: "clear",
      }))
    ) {
      return;
    }
    clearDecisions();
    ctx.notify("Cleared review triage decisions");
  });

  hunk.on("changeset_loaded", ({ changeset }) => reconcileChangeset(changeset));
  hunk.on("session_reload", ({ changeset }) => reconcileChangeset(changeset));
  hunk.on("selection_changed", ({ fileId, hunkIndex }) => {
    updateSnapshot((current) => ({
      ...current,
      current: fileId !== null && hunkIndex !== null ? { fileId, hunkIndex } : null,
    }));
  });
  hunk.on("hunk_viewed", ({ file, hunkIndex }) => markViewed(file, hunkIndex));
  hunk.on("note_created", ({ note }) => recordNote(note));
  hunk.on("filter_changed", ({ filter }) => {
    updateSnapshot((current) => ({ ...current, filter }));
  });
  hunk.on("watch_reload_pending", () => {
    updateSnapshot((current) => ({ ...current, reloadPending: true }));
  });

  // Lets another extension reveal this board without importing its module state.
  hunk.events.on("review-triage:open", (_payload, ctx) => ctx.panes.open("triage"));
}
