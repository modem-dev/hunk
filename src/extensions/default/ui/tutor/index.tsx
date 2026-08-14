import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import type {
  ExtensionChangeset,
  ExtensionCommandContext,
  ExtensionEventContext,
  ExtensionPaneProps,
  HunkExtensionAPI,
} from "../../../../extension-api/types";
import { getTutorDocumentText } from "../../../../tutor/content";
import { runExtensionFactory } from "../../../runExtension";
import type { ExtensionLoadResult, ExtensionMetadata } from "../../../types";

const TUTOR_EXTENSION_ID = "hunk-tutor";
const TUTOR_HIGHLIGHTER_ID = "active-step";

interface TutorTask {
  id: string;
  commandId?: string;
  label: string;
  literalKey?: string;
  /** Exact changed text the active-step spotlight paints in the review. */
  spotlight: string;
}

interface TutorLesson {
  id: string;
  title: string;
  subtitle: string;
  targetPath: string;
  tasks: readonly TutorTask[];
}

const TUTOR_LESSONS: readonly TutorLesson[] = [
  {
    id: "orientation",
    title: "01 · Move through a review",
    subtitle: "The current row shows where you are; the spotlight shows what this step reveals.",
    targetPath: "01-moving-through-a-review.md",
    tasks: [
      {
        id: "help",
        commandId: "hunk.app.toggleHelp",
        label: "open the controls card",
        spotlight: "controls help",
      },
      {
        id: "down",
        commandId: "hunk.review.stepDown",
        label: "move down one row",
        spotlight: "Move down once",
      },
      {
        id: "up",
        commandId: "hunk.review.stepUp",
        label: "move up one row",
        spotlight: "back up",
      },
      {
        id: "next-hunk",
        commandId: "hunk.review.nextHunk",
        label: "visit the next hunk",
        spotlight: "Hunk jumps",
      },
      {
        id: "previous-hunk",
        commandId: "hunk.review.previousHunk",
        label: "return one hunk",
        spotlight: "A hunk groups",
      },
      {
        id: "next-file",
        commandId: "hunk.review.nextFile",
        label: "visit the next file",
        spotlight: "Next-file",
      },
      {
        id: "previous-file",
        commandId: "hunk.review.previousFile",
        label: "return one file",
        spotlight: "Previous-file",
      },
      {
        id: "top",
        commandId: "hunk.review.jumpToTop",
        label: "jump to the beginning",
        spotlight: "Top reveals",
      },
      {
        id: "bottom",
        commandId: "hunk.review.jumpToBottom",
        label: "jump to the end",
        spotlight: "Bottom previews",
      },
    ],
  },
  {
    id: "momentum",
    title: "02 · Cover distance",
    subtitle:
      "Find the labeled checkpoints, then practice moving across a line wider than the pane.",
    targetPath: "02-scrolling-and-panning.md",
    tasks: [
      {
        id: "page-down",
        commandId: "hunk.review.pageDown",
        label: "page down until the PAGE CHECKPOINT appears",
        spotlight: "PAGE CHECKPOINT",
      },
      {
        id: "page-up",
        commandId: "hunk.review.pageUp",
        label: "return to the lesson heading",
        spotlight: "Lesson 2 — Cover distance",
      },
      {
        id: "half-down",
        commandId: "hunk.review.halfPageDown",
        label: "find the HALF-PAGE CHECKPOINT",
        spotlight: "HALF-PAGE CHECKPOINT",
      },
      {
        id: "half-up",
        commandId: "hunk.review.halfPageUp",
        label: "return to the wide line",
        spotlight: "PAN RIGHT",
      },
      {
        id: "right",
        commandId: "hunk.review.scrollCodeRight",
        label: "pan right across the wide line (Shift is faster)",
        spotlight: "YOU FOUND IT",
      },
      {
        id: "left",
        commandId: "hunk.review.scrollCodeLeft",
        label: "pan left toward the line's beginning",
        spotlight: "PAN RIGHT",
      },
      {
        id: "context",
        commandId: "hunk.review.toggleHunkGap",
        label: "expand the folded explanation",
        spotlight: "YOU REVEALED THE FOLDED GUIDE",
      },
    ],
  },
  {
    id: "shape",
    title: "03 · Shape the view",
    subtitle: "Change the presentation and read the line that explains what each choice buys you.",
    targetPath: "03-shaping-the-view.md",
    tasks: [
      {
        id: "split",
        commandId: "hunk.view.layoutSplit",
        label: "choose split diff",
        spotlight: "Split:",
      },
      {
        id: "stack",
        commandId: "hunk.view.layoutStack",
        label: "choose stacked diff",
        spotlight: "Stack:",
      },
      {
        id: "auto",
        commandId: "hunk.view.layoutAuto",
        label: "restore responsive auto",
        spotlight: "Auto:",
      },
      {
        id: "lines",
        commandId: "hunk.view.toggleLineNumbers",
        label: "toggle line numbers",
        spotlight: "Line numbers",
      },
      {
        id: "wrap",
        commandId: "hunk.view.toggleLineWrap",
        label: "wrap the long explanation",
        spotlight: "WRAP THIS LONG EXPLANATION",
      },
      {
        id: "metadata",
        commandId: "hunk.view.toggleHunkHeaders",
        label: "toggle source ranges",
        spotlight: "Hunk headers",
      },
      {
        id: "theme",
        commandId: "hunk.view.openThemeSelector",
        label: "choose a theme with Enter",
        spotlight: "Themes change",
      },
      {
        id: "menu",
        commandId: "hunk.view.toggleMenuBar",
        label: "hide or show the menu bar",
        spotlight: "The menu",
      },
      {
        id: "sidebar",
        commandId: "hunk.view.toggleSidebar",
        label: "hide this pane; finishing the lesson brings it back",
        spotlight: "Hide Tutor",
      },
    ],
  },
  {
    id: "focus",
    title: "04 · Find a file",
    subtitle:
      "Filter the review to the file named needle, then clear it to restore the full guide.",
    targetPath: "04-find-a-file/needle.md",
    tasks: [
      {
        id: "focus-filter",
        commandId: "hunk.review.focusFilter",
        label: "focus the file filter",
        spotlight: "Focus the filter",
      },
      {
        id: "filter-text",
        label: "type needle, read the isolated file, then press Escape",
        literalKey: "needle → Esc",
        spotlight: "only visible file",
      },
      {
        id: "focus-area",
        commandId: "hunk.app.toggleFocusArea",
        label: "switch files/filter focus",
        spotlight: "Focus switches",
      },
      {
        id: "refresh",
        commandId: "hunk.app.refresh",
        label: "reload this safe synthetic review",
        spotlight: "Refresh reloads",
      },
      {
        id: "editor",
        commandId: "hunk.review.editSelectedFile",
        label: "try the editor handoff; this tutorial has no real file",
        spotlight: "Editor handoff",
      },
    ],
  },
  {
    id: "context",
    title: "05 · Review with context",
    subtitle: "Agent rationale and human questions belong beside the exact lines they explain.",
    targetPath: "05-context-and-notes.md",
    tasks: [
      {
        id: "agent-notes",
        commandId: "hunk.view.toggleAgentNotes",
        label: "reveal agent notes",
        spotlight: "Agent notes explain why",
      },
      {
        id: "next-annotation",
        commandId: "hunk.review.nextAnnotatedHunk",
        label: "jump to the next annotated hunk",
        spotlight: "land on explained changes",
      },
      {
        id: "previous-annotation",
        commandId: "hunk.review.previousAnnotatedHunk",
        label: "jump to the previous annotated hunk",
        spotlight: "exact lines",
      },
      {
        id: "start-note",
        commandId: "hunk.review.startNote",
        label: "start a human review note",
        spotlight: "Start a note",
      },
      {
        id: "save-note",
        label: "type a thought and save it",
        literalKey: "Ctrl+S",
        spotlight: "Save it beside",
      },
    ],
  },
  {
    id: "extensions",
    title: "06 · How the tutor works",
    subtitle: "The guide itself explains how public extensions can add behavior to Hunk.",
    targetPath: "06-how-the-tutor-works.md",
    tasks: [
      {
        id: "finished",
        label: "open the finish dialog",
        literalKey: "Ctrl+G",
        spotlight: "Use Finish",
      },
    ],
  },
];

interface TutorSnapshot {
  completed: ReadonlySet<string>;
  lastCompleted: string | null;
}

let snapshot: TutorSnapshot = { completed: new Set(), lastCompleted: null };
const listeners = new Set<() => void>();
const tutorFileIds = new Map<string, string>();
let needleFilterArmed = false;

/** Return the first unfinished task, optionally constrained to one lesson. */
function findActiveTask(lesson?: TutorLesson) {
  const tasks = lesson?.tasks ?? TUTOR_LESSONS.flatMap((candidate) => candidate.tasks);
  return tasks.find((task) => !snapshot.completed.has(task.id));
}

/** Locate one task's spotlight in exact new-side source coordinates. */
function resolveSpotlight(lesson: TutorLesson, task: TutorTask, document: string | null) {
  if (!document) {
    return null;
  }

  for (const [index, line] of document.split("\n").entries()) {
    const start = line.indexOf(task.spotlight);
    if (start >= 0) {
      return {
        path: lesson.targetPath,
        side: "new" as const,
        line: index + 1,
        range: [start, start + task.spotlight.length] as const,
      };
    }
  }
  return null;
}

/** Expose the deterministic spotlight plan for focused contract tests. */
export function getTutorSpotlightPlan() {
  return TUTOR_LESSONS.flatMap((lesson) =>
    lesson.tasks.flatMap((task) => {
      const spotlight = resolveSpotlight(
        lesson,
        task,
        getTutorDocumentText(lesson.targetPath, "new"),
      );
      return spotlight ? [{ taskId: task.id, phrase: task.spotlight, ...spotlight }] : [];
    }),
  );
}

/** Resolve the active task, its lesson, and its exact source-coordinate spotlight. */
function resolveActiveSpotlight(readDocument: (path: string) => string | null) {
  const task = findActiveTask();
  const lesson = task
    ? TUTOR_LESSONS.find((candidate) => candidate.tasks.some((entry) => entry.id === task.id))
    : undefined;
  if (!lesson || !task) {
    return null;
  }

  const spotlight = resolveSpotlight(lesson, task, readDocument(lesson.targetPath));
  return spotlight ? { lesson, task, spotlight } : null;
}

/** Publish one immutable progress snapshot even while the tutorial pane is closed. */
function updateSnapshot(update: (current: TutorSnapshot) => TutorSnapshot) {
  const next = update(snapshot);
  if (next === snapshot) {
    return;
  }

  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Subscribe the sidebar to progress recorded by extension event handlers. */
function useTutorSnapshot() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

/** Navigate to the lesson's curated example when its file is currently reviewable. */
function navigateToLesson(
  lesson: TutorLesson,
  ctx: ExtensionEventContext | ExtensionCommandContext,
) {
  const fileId = tutorFileIds.get(lesson.targetPath);
  if (!fileId) {
    return;
  }

  const task = findActiveTask(lesson);
  const spotlight = task
    ? resolveSpotlight(lesson, task, getTutorDocumentText(lesson.targetPath, "new"))
    : null;
  if (spotlight) {
    ctx.navigation.revealLine(fileId, spotlight.side, spotlight.line);
  } else {
    ctx.navigation.selectFile(fileId);
  }
}

/** Mark one task complete, reveal the guide, and stage the next lesson's example. */
function completeTask(taskId: string, ctx?: ExtensionEventContext | ExtensionCommandContext) {
  if (snapshot.completed.has(taskId)) {
    return;
  }

  const completedBefore = new Set(snapshot.completed);
  const completed = new Set(completedBefore).add(taskId);
  updateSnapshot((current) => ({ ...current, completed, lastCompleted: taskId }));
  ctx?.highlights.refresh(TUTOR_HIGHLIGHTER_ID);

  const finishedLesson = TUTOR_LESSONS.find(
    (lesson) =>
      lesson.tasks.some((task) => task.id === taskId) &&
      lesson.tasks.every((task) => completed.has(task.id)) &&
      !lesson.tasks.every((task) => completedBefore.has(task.id)),
  );
  if (finishedLesson) {
    ctx?.notify(`${finishedLesson.title} complete ✨`);
    ctx?.panes.open("guide");
    const nextLesson = TUTOR_LESSONS.find(
      (lesson) => !lesson.tasks.every((task) => completed.has(task.id)),
    );
    if (ctx && nextLesson) {
      navigateToLesson(nextLesson, ctx);
    }
  }
}

/** Reset progress without disturbing the user's review state. */
function resetProgress(ctx: ExtensionCommandContext) {
  needleFilterArmed = false;
  updateSnapshot(() => ({ completed: new Set(), lastCompleted: null }));
  ctx.highlights.refresh(TUTOR_HIGHLIGHTER_ID);
}

/** Return every useful key label from the user's effective keymap. */
function taskKeys(task: TutorTask, keybindings: ExtensionPaneProps["keybindings"]) {
  if (task.literalKey) {
    return [task.literalKey];
  }

  const keys = task.commandId ? keybindings.getKeys(task.commandId) : [];
  return keys.length > 0 ? [...keys] : ["menu"];
}

/** Keep one compact tutor line inside its pane. */
function fitLine(text: string, width: number) {
  if (text.length <= width) {
    return text;
  }

  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

/** Wrap prose into deterministic sidebar-width lines without splitting words unnecessarily. */
function wrapLines(text: string, width: number) {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = current.length === 0 ? word : `${current} ${word}`;
    if (next.length <= width) {
      current = next;
      continue;
    }

    if (current.length > 0) {
      lines.push(current);
    }
    current = fitLine(word, width);
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

/** Render a live, clickable lesson pane driven entirely through public pane props. */
function TutorSidebar({
  files,
  width,
  theme,
  keybindings,
  actions,
}: ExtensionPaneProps): ReactNode {
  const state = useTutorSnapshot();
  const allTasks = useMemo(() => TUTOR_LESSONS.flatMap((lesson) => lesson.tasks), []);
  const completeCount = allTasks.filter((task) => state.completed.has(task.id)).length;
  const activeTask = allTasks.find((task) => !state.completed.has(task.id));
  const activeLesson =
    TUTOR_LESSONS.find((lesson) => !lesson.tasks.every((task) => state.completed.has(task.id))) ??
    TUTOR_LESSONS.at(-1)!;
  const target = files.find((file) => file.path === activeLesson.targetPath);
  const targetSpotlight = activeTask
    ? resolveSpotlight(
        activeLesson,
        activeTask,
        getTutorDocumentText(activeLesson.targetPath, "new"),
      )
    : null;
  const innerWidth = Math.max(8, width - 2);
  const barWidth = Math.max(4, Math.min(14, innerWidth - 10));
  const filled = Math.round((completeCount / allTasks.length) * barWidth);
  const lessonIndex = TUTOR_LESSONS.indexOf(activeLesson);
  const taskKeysLabel = activeTask ? taskKeys(activeTask, keybindings).join(" · ") : "";
  const quitKeys = keybindings.getKeys("hunk.app.quit").join(" · ") || "menu";

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
        <text content=" ◆ HUNK TUTOR" style={{ fg: theme.accent, bg: theme.panel }} />
        <text
          content={fitLine(
            ` [${"◆".repeat(filled)}${"·".repeat(barWidth - filled)}] ${completeCount}/${allTasks.length}`,
            innerWidth,
          )}
          style={{ fg: theme.accentMuted, bg: theme.panel }}
        />
        <text content=" " style={{ bg: theme.panel }} />
        <text
          content={fitLine(` ${activeLesson.title}`, innerWidth)}
          style={{ fg: theme.text, bg: theme.panel }}
          onMouseUp={() => {
            if (!target) return;
            if (targetSpotlight) {
              actions.revealLine(target.id, targetSpotlight.side, targetSpotlight.line);
            } else {
              actions.selectFile(target.id);
            }
          }}
        />
        <text
          content={fitLine(` Lesson ${lessonIndex + 1}/${TUTOR_LESSONS.length}`, innerWidth)}
          style={{ fg: theme.accentMuted, bg: theme.panel }}
        />
        <text content=" " style={{ bg: theme.panel }} />
        {activeTask ? (
          <>
            <text
              content={fitLine(" NEXT STEP", innerWidth)}
              style={{ fg: theme.accent, bg: theme.selectedHunk }}
            />
            <text content=" " style={{ bg: theme.selectedHunk }} />
            <text
              content={fitLine(` ${taskKeysLabel}`, innerWidth)}
              style={{ fg: theme.text, bg: theme.selectedHunk }}
            />
            {wrapLines(activeTask.label, Math.max(1, innerWidth - 2)).map((line, index) => (
              <text
                key={`task:${activeTask.id}:${index}`}
                content={fitLine(` ${line}`, innerWidth)}
                style={{ fg: theme.text, bg: theme.selectedHunk }}
              />
            ))}
            <text content=" " style={{ bg: theme.selectedHunk }} />
            <text content=" " style={{ bg: theme.panel }} />
            {wrapLines(activeLesson.subtitle, Math.max(1, innerWidth - 2)).map((line, index) => (
              <text
                key={`lesson:${activeLesson.id}:${index}`}
                content={fitLine(` ${line}`, innerWidth)}
                style={{ fg: theme.muted, bg: theme.panel }}
              />
            ))}
            <text content=" " style={{ bg: theme.panel }} />
            <text
              content={fitLine(" Do it, then find the spotlight.", innerWidth)}
              style={{ fg: theme.badgeAdded, bg: theme.panel }}
            />
          </>
        ) : (
          <>
            <text
              content={fitLine(" TUTOR COMPLETE ✓", innerWidth)}
              style={{ fg: theme.badgeAdded, bg: theme.selectedHunk }}
            />
            <text content=" " style={{ bg: theme.selectedHunk }} />
            <text
              content={fitLine(" Open a real review when you are ready.", innerWidth)}
              style={{ fg: theme.text, bg: theme.selectedHunk }}
            />
          </>
        )}
        <text content=" " style={{ bg: theme.panel }} />
        <text
          content={fitLine(" click title to reveal spotlight", innerWidth)}
          style={{ fg: theme.muted, bg: theme.panel }}
        />
        <text
          content={fitLine(` F10 menus · ${quitKeys} exit`, innerWidth)}
          style={{ fg: theme.muted, bg: theme.panel }}
        />
      </box>
    </scrollbox>
  );
}

/** Add curated rationale to the synthetic files without reaching into renderer metadata. */
function annotateTutorChangeset(changeset: ExtensionChangeset): ExtensionChangeset {
  if (changeset.sourceLabel !== "hunk tutor") {
    return changeset;
  }

  return {
    ...changeset,
    agentSummary:
      "The tutor is ordered so each navigation step reveals the explanation for why it is useful.",
    files: changeset.files.map((file) => {
      const annotations =
        file.path === "05-context-and-notes.md"
          ? [
              {
                newRange: [4, 5] as [number, number],
                summary: "Agent explanations stay attached to the changed lines they describe.",
                rationale: "Annotation navigation skips directly between changes with rationale.",
                confidence: "high" as const,
                author: "Hunk Tutor",
              },
              {
                newRange: [21, 23] as [number, number],
                summary: "Human notes preserve the reviewer's question beside its target hunk.",
                rationale: "Start a note here, write a thought, and save it without leaving Hunk.",
                confidence: "high" as const,
                author: "Hunk Tutor",
              },
            ]
          : file.path === "06-how-the-tutor-works.md"
            ? [
                {
                  newRange: [11, 13] as [number, number],
                  summary: "The tutor observes named commands, not hard-coded keys.",
                  rationale:
                    "That is why this pane follows your personal [keybindings] configuration.",
                  confidence: "high" as const,
                  author: "Hunk",
                },
              ]
            : [];

      return annotations.length === 0
        ? file
        : {
            ...file,
            agent: {
              path: file.path,
              summary: "An instructional example with rationale attached to its exact lesson.",
              annotations,
            },
          };
    }),
  };
}

/** Register the interactive tutor using the same public surface third-party extensions receive. */
export default function registerTutor(hunk: HunkExtensionAPI) {
  hunk.configureSession({ viewPreferences: "transient" });
  hunk.registerTheme({
    id: "hunk-tutor",
    label: "Hunk Tutor",
    base: "catppuccin-mocha",
    accent: "#7dd3fc",
    badgeAdded: "#86efac",
    badgeRemoved: "#f0abfc",
  });
  hunk.registerLineHighlighter({
    id: TUTOR_HIGHLIGHTER_ID,
    async highlight({ file, readDocument }) {
      const document = await readDocument("new");
      const active = resolveActiveSpotlight((path) => (path === file.path ? document : null));
      if (!active || active.lesson.targetPath !== file.path) {
        return null;
      }

      return [
        {
          side: active.spotlight.side,
          line: active.spotlight.line,
          range: active.spotlight.range,
          tone: "current",
        },
      ];
    },
  });
  hunk.registerPane({
    id: "guide",
    title: "Hunk Tutor",
    placement: "left",
    width: { preferred: 34, min: 22 },
    defaultOpen: true,
    replaces: "hunk:files",
    component: TutorSidebar,
  });
  hunk.registerCommand(
    { id: "finish", title: "Finish Hunk Tutor…", key: "ctrl+g" },
    async (ctx) => {
      const ready = await ctx.dialogs.confirm({
        title: "Finish Hunk Tutor?",
        body: "Mark the tutorial complete, then use your quit key to leave. You can return anytime with `hunk tutor`.",
        confirmLabel: "finish",
        cancelLabel: "keep learning",
      });
      if (ready) {
        completeTask("finished", ctx);
        ctx.notify("Hunk Tutor complete — you are ready for a real review ✓");
      }
    },
  );
  hunk.registerCommand({ id: "restart", title: "Restart tutor progress" }, (ctx) => {
    resetProgress(ctx);
    ctx.panes.open("guide");
    navigateToLesson(TUTOR_LESSONS[0]!, ctx);
    ctx.notify("Tutor progress reset");
  });
  hunk.transformChangeset(annotateTutorChangeset);

  hunk.on("command_executed", ({ commandId }, ctx) => {
    for (const task of TUTOR_LESSONS.flatMap((lesson) => lesson.tasks)) {
      // Theme selection completes only after the user accepts a preview.
      if (task.commandId === commandId && task.id !== "theme") {
        if (task.id === "editor") {
          ctx.notify("Tutorial handoff only • in a real review, this opens the file in $EDITOR");
        }
        completeTask(task.id, ctx);
      }
    }
  });
  hunk.on("filter_changed", ({ filter }, ctx) => {
    if (filter.trim().toLowerCase().includes("needle")) {
      needleFilterArmed = true;
      return;
    }
    if (needleFilterArmed && filter.trim().length === 0) {
      needleFilterArmed = false;
      completeTask("filter-text", ctx);
    }
  });
  hunk.on("theme_changed", (_event, ctx) => completeTask("theme", ctx));
  hunk.on("note_created", (_event, ctx) => completeTask("save-note", ctx));
  hunk.on("changeset_loaded", ({ changeset }) => {
    tutorFileIds.clear();
    for (const file of changeset.files) {
      tutorFileIds.set(file.path, file.id);
    }
  });
  hunk.on("startup", async (_event, ctx) => {
    ctx.panes.open("guide");
    navigateToLesson(TUTOR_LESSONS[0]!, ctx);
    await ctx.dialogs.confirm({
      title: "Welcome to Hunk Tutor",
      body: "The diff itself is the guide. Follow one step in the Tutor pane, then find the spotlight on the exact text your action reveals.",
      confirmLabel: "start lesson 1",
      cancelLabel: "skip intro",
    });
    ctx.notify("Lesson 1 is ready • open controls help");
  });
}

/** Install the bundled tutor into one interactive tutor session's existing registry. */
export function installBundledTutorExtension(result: ExtensionLoadResult) {
  const metadata: ExtensionMetadata = {
    id: TUTOR_EXTENSION_ID,
    sourcePath: "hunk:bundled/tutor",
    origin: "bundled",
  };
  runExtensionFactory({
    metadata,
    registry: result.registry,
    issues: result.issues,
    factory: registerTutor,
  });
  if (result.registry.extensions.includes(metadata)) {
    result.loaded.push(metadata);
  }
}
