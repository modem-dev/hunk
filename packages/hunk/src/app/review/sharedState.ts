/**
 * Projects one live review onto the shared-state snapshot a browser reads (`ReviewSharedStateV1`).
 *
 * The producer materializes this once per shared revision when the daemon asks for
 * `/review-api/<session>/state`; the terminal and a headless session feed it the same host and
 * the presentation defaults their launch resolved. Notes are listed in the order the terminal
 * presents them — per file in document order, sidecar annotations then stored notes in thread
 * order — and sidecar annotations are normalized into `ReviewNoteV1` with ids stable across
 * snapshots of one review. Selection is not part of it: every surface keeps its own.
 */
import type { AppBootstrap } from "../../core/bootstrap";
import { reviewAnnotationAnchor, reviewNoteSource } from "../../core/review/annotations";
import { createSidecarProjectionBudget } from "../../core/review/noteSize";
import {
  selectIsReviewFileViewed,
  selectThreadedStoredReviewNotes,
} from "../../core/review/selectors";
import { isRenderableStoredReviewNote } from "../../core/review/state";
import type { ReviewNoteV1 } from "../../core/review/types";
import { APP_COMMAND_CATALOG } from "../../core/run/commandCatalog";
import { DOCUMENT_COMMAND_NAMES } from "../../core/run/documentCommandCatalog";
import { HISTORY_COMMAND_NAMES } from "../../core/run/historyCommandCatalog";
import { resolveCommandKeys } from "../../core/run/keymap";
import { STATUS_COMMAND_NAMES } from "../../core/run/statusCommandCatalog";
import { resolveTheme, THEMES, type AppTheme } from "../../core/theme/appTheme";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../../session/reviewProtocol";
import type {
  ReviewAgentHighlightV1,
  ReviewPresentationDefaultsV1,
  ReviewSharedNoteV1,
  ReviewSharedStateV1,
  ReviewThemeDefaultsV1,
} from "../../session/reviewSharedState";
import type { ReviewSessionHost } from "./reviewSessionHost";
import { indexReviewFiles } from "./reviewSessionProjections";

/** Drop keys whose value is undefined, so the JSON form and the parsed form agree exactly. */
function definedFields<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Describe the theme a session resolved: by id when built in, by tokens otherwise. */
function themeDefaults(theme: AppTheme): ReviewThemeDefaultsV1 {
  if (THEMES.some((builtIn) => builtIn.id === theme.id)) {
    return { kind: "builtin", id: theme.id, appearance: theme.appearance };
  }
  const {
    id,
    label,
    appearance,
    syntaxColors,
    syntaxTheme,
    syntaxScopeOverrides,
    syntaxScopesReplaceBase,
    ...tokens
  } = theme;
  return definedFields({
    kind: "custom" as const,
    id,
    label,
    appearance,
    tokens: Object.fromEntries(
      Object.entries(tokens).filter(([, value]) => typeof value === "string"),
    ) as Record<string, string>,
    syntaxColors: definedFields({ ...syntaxColors }) as Record<string, string>,
    syntaxTheme,
    syntaxScopeOverrides,
    syntaxScopesReplaceBase,
  });
}

/**
 * Resolve the presentation defaults one launch implies (G1, E2).
 *
 * The theme is resolved exactly as the terminal resolves its first frame; the keymap folds the
 * user's `[keybindings]` over the built-in review commands with the same resolver the terminal
 * dispatches through. Extension commands are not included: a browser cannot run them (F4).
 */
export function buildReviewPresentationDefaults(
  bootstrap: AppBootstrap,
): ReviewPresentationDefaultsV1 {
  const theme = resolveTheme(
    bootstrap.initialTheme,
    bootstrap.initialThemeMode ?? null,
    bootstrap.customThemes ?? [],
  );
  const keymap = resolveCommandKeys({
    defaults: APP_COMMAND_CATALOG.map((entry) => ({
      id: entry.id,
      aliases: entry.aliases,
      defaultKeys: entry.defaultKeys,
    })),
    inactiveCommandNames: new Set([
      ...HISTORY_COMMAND_NAMES,
      ...DOCUMENT_COMMAND_NAMES,
      ...STATUS_COMMAND_NAMES,
    ]),
    userBindings: bootstrap.keybindings,
  });
  return {
    title: bootstrap.changeset.title,
    sourceLabel: bootstrap.changeset.sourceLabel,
    theme: themeDefaults(theme),
    view: {
      layout: bootstrap.initialMode,
      wrapLines: bootstrap.initialWrapLines ?? false,
      lineNumbers: bootstrap.initialShowLineNumbers ?? true,
      hunkHeaders: bootstrap.initialShowHunkHeaders ?? true,
    },
    keymap: Object.fromEntries(
      APP_COMMAND_CATALOG.map((entry) => [entry.id, [...(keymap.keys.get(entry.id) ?? [])]]),
    ),
  };
}

/**
 * List every renderable note in the order the terminal presents them.
 *
 * Sidecar annotations past the projected sidecar bounds are omitted and counted, so an
 * oversized sidecar cannot push the snapshot past its size bound; stored notes are already
 * bounded where they are added.
 */
function sharedNotes(host: ReviewSessionHost): { notes: ReviewSharedNoteV1[]; omitted: number } {
  const files = host.getFiles();
  const fileIndex = indexReviewFiles(host.getDocument(), files);
  const storedByFileId = new Map<string, ReviewSharedNoteV1[]>();
  for (const { entry } of selectThreadedStoredReviewNotes(host.getSnapshot())) {
    const file = fileIndex.fileByKey.get(entry.note.fileKey);
    if (!file || !isRenderableStoredReviewNote(entry)) continue;
    const notes = storedByFileId.get(file.id) ?? [];
    notes.push({
      note: entry.note,
      resolution: entry.resolution === "stale" ? "stale" : "active",
      origin: entry.note.source === "user" ? "user" : "live",
    });
    storedByFileId.set(file.id, notes);
  }

  const notes: ReviewSharedNoteV1[] = [];
  const sidecarBudget = createSidecarProjectionBudget();
  for (const file of files) {
    const fileKey = fileIndex.keyByFileId.get(file.id);
    if (!fileKey) continue;
    (file.agent?.annotations ?? []).forEach((annotation, index) => {
      const source = reviewNoteSource(annotation);
      const note: ReviewNoteV1 = definedFields({
        id: annotation.id ?? `${source}:${fileKey}:${index}`,
        source,
        originalSource: annotation.source,
        fileKey,
        anchor: definedFields(reviewAnnotationAnchor(file.metadata.hunks, annotation)),
        summary: annotation.summary,
        rationale: annotation.rationale,
        // The terminal strips sidecar STML when the launch did not enable it
        // (`resolveExperimentalDiffFiles`); the snapshot says what the terminal shows.
        markup: host.isStmlEnabled() ? annotation.markup : undefined,
        title: annotation.title,
        author: annotation.author,
        createdAt: annotation.createdAt,
        updatedAt: annotation.updatedAt,
        editable: false,
        tags: annotation.tags,
        confidence: annotation.confidence,
      });
      if (sidecarBudget.admit(note)) notes.push({ note, resolution: "active", origin: "sidecar" });
    });
    notes.push(...(storedByFileId.get(file.id) ?? []));
  }
  return { notes, omitted: sidecarBudget.omitted };
}

/** Build one review's shared-state snapshot at the host's current revision. */
export function buildReviewSharedState(
  host: ReviewSessionHost,
  options: { generation: string; presentation: ReviewPresentationDefaultsV1 },
): ReviewSharedStateV1 {
  const state = host.getSnapshot();
  const document = host.getDocument();
  const agentHighlights: Record<string, ReviewAgentHighlightV1[]> = {};
  for (const [fileId, marks] of host.getAgentLineHighlights()) {
    const fileKey = host.fileKeyFor(fileId);
    if (!fileKey || marks.length === 0) continue;
    agentHighlights[fileKey] = marks.map(({ side, line, start, end, tone }) => ({
      side,
      line,
      start,
      end,
      tone,
    }));
  }

  const { notes, omitted } = sharedNotes(host);
  return {
    protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
    generation: options.generation,
    stateRevision: state.stateRevision,
    sharedStateRevision: host.getSharedStateRevision(),
    files: document.files.map((file) =>
      definedFields({
        key: file.key,
        path: file.path,
        previousPath: file.previousPath,
        changeKind: file.changeKind,
        language: file.language,
        stats: { ...file.stats },
        flags: { ...file.flags },
        splitLineCount: file.splitLineCount,
        unifiedLineCount: file.unifiedLineCount,
        contentIdentity: file.contentIdentity,
        agentSummary: file.agentSummary,
        // The terminal's annotated-file scope includes every file the sidecar names
        // (`buildReviewAnnotationIndex`), so the snapshot names them too.
        agentContext: host.fileForKey(file.key)?.agent ? (true as const) : undefined,
      }),
    ),
    notes,
    filter: state.filter,
    showAgentNotes: state.showAgentNotes,
    viewedFiles: Object.fromEntries(
      document.files.flatMap((file) =>
        selectIsReviewFileViewed(state, file.key)
          ? [[file.key, { contentIdentity: file.contentIdentity }] as const]
          : [],
      ),
    ),
    agentHighlights,
    agentReveal: host.getAgentReveal(),
    presentation: options.presentation,
    ...(omitted > 0 ? { omittedSidecarNotes: omitted } : {}),
  };
}
