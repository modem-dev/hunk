import { useMemo } from "react";
import { ACTIONS, type ActionDef } from "../../../core/keymap/actions";
import { formatBinding } from "../../../core/keymap/format";
import { getActionSpecs, type Keymap } from "../../../core/keymap/match";
import type { KeySpec } from "../../../core/keymap/parse";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { ModalFrame } from "./ModalFrame";

interface HelpRow {
  keys: string;
  description: string;
}

interface HelpSection {
  title: string;
  items: HelpRow[];
}

/** Hardcoded mouse hints; the keymap doesn't model mouse input. */
const MOUSE_SECTION: HelpSection = {
  title: "Mouse",
  items: [
    { keys: "Wheel", description: "scroll vertically" },
    { keys: "Shift+Wheel", description: "scroll code horizontally" },
  ],
};

// Hard-coded note shortcuts; these use strict-modifier matchers that the
// keymap registry can't express, so they live outside ACTIONS.
const NOTES_SECTION: HelpSection = {
  title: "Notes",
  items: [
    { keys: "c", description: "create review note" },
    { keys: "Ctrl+S", description: "save draft note" },
    { keys: "Esc", description: "cancel draft note" },
  ],
};

/**
 * Group registered actions for the help dialog. Sections appear in the order
 * each `group` first appears in the registry, and rows within a group keep
 * registry order so related actions stay adjacent.
 */
function buildHelpSections(keymap: Keymap, canRefresh: boolean): HelpSection[] {
  const order: string[] = [];
  const buckets = new Map<string, HelpRow[]>();

  const trackedActions = ACTIONS.filter((action) => {
    // Pager/menu/filter-scope entries duplicate global navigation; hide them
    // to avoid noise in the help dialog (they share the same action ids).
    if (action.scope !== "global") return false;
    if (action.id === "reload" && !canRefresh) return false;
    return true;
  });

  for (const action of trackedActions) {
    const specs = getActionSpecs(keymap, action);
    const row = buildRow(action, specs);

    let bucket = buckets.get(action.group);
    if (!bucket) {
      bucket = [];
      buckets.set(action.group, bucket);
      order.push(action.group);
    }
    bucket.push(row);
  }

  const sections: HelpSection[] = order.map((title) => ({
    title,
    items: buckets.get(title) ?? [],
  }));

  // Preserve "Mouse" placement between Navigation and View; it sits with the
  // primary movement controls. Insert just before the "View" group.
  const viewIndex = sections.findIndex((section) => section.title === "View");
  const insertAt = viewIndex >= 0 ? viewIndex : sections.length;
  sections.splice(insertAt, 0, MOUSE_SECTION);
  sections.push(NOTES_SECTION);

  return sections;
}

function buildRow(action: ActionDef, specs: KeySpec[]): HelpRow {
  const keys = specs.length === 0 ? "disabled" : formatBinding(specs);
  return {
    keys,
    description: action.description,
  };
}

/** Render the in-app controls help modal. */
export function HelpDialog({
  canRefresh = false,
  keymap,
  terminalHeight,
  terminalWidth,
  theme,
  onClose,
}: {
  canRefresh?: boolean;
  keymap: Keymap;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  onClose: () => void;
}) {
  const sections = useMemo(() => buildHelpSections(keymap, canRefresh), [keymap, canRefresh]);

  const width = Math.min(74, Math.max(56, terminalWidth - 8));
  const bodyWidth = Math.max(1, width - 4);
  const keyWidth = Math.min(20, Math.max(12, Math.floor(bodyWidth * 0.32)));
  const descriptionWidth = Math.max(1, bodyWidth - keyWidth);
  const sectionSpacerRowCount = Math.max(0, sections.length - 1);
  const contentRowCount =
    sections.reduce((rowCount, section) => rowCount + 1 + section.items.length, 0) +
    sectionSpacerRowCount;
  // ModalFrame contributes the border rows, title row, padding, and one blank spacer row.
  const modalFrameChromeRowCount = 6;
  const requiredModalHeight = contentRowCount + modalFrameChromeRowCount;
  const modalHeight = Math.min(requiredModalHeight, Math.max(8, terminalHeight - 2));
  const shouldScroll = modalHeight < requiredModalHeight;
  const content = (
    <box style={{ width: "100%", flexDirection: "column" }}>
      {sections.map((section, sectionIndex) => (
        <box key={section.title} style={{ width: "100%", flexDirection: "column" }}>
          <box style={{ width: "100%", height: 1 }}>
            <text fg={theme.badgeNeutral}>{section.title}</text>
          </box>
          {section.items.map((row) => (
            <box
              key={`${section.title}:${row.keys}:${row.description}`}
              style={{ width: "100%", height: 1, flexDirection: "row" }}
            >
              <text fg={theme.accent}>{padText(fitText(row.keys, keyWidth), keyWidth)}</text>
              <text fg={theme.muted}>{fitText(row.description, descriptionWidth)}</text>
            </box>
          ))}
          {sectionIndex < sections.length - 1 ? <box style={{ width: "100%", height: 1 }} /> : null}
        </box>
      ))}
    </box>
  );

  return (
    <ModalFrame
      height={modalHeight}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title="Controls help"
      width={width}
      onClose={onClose}
    >
      {shouldScroll ? (
        <scrollbox focused={false} height="100%" scrollY={true} width="100%">
          {content}
        </scrollbox>
      ) : (
        content
      )}
    </ModalFrame>
  );
}
