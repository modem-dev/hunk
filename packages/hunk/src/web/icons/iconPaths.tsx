/** @jsxImportSource react */
/**
 * Draws the page's icons as SVG children on a 16px grid, stroked in `currentColor`.
 *
 * Each entry is named by what it depicts, not by the control that uses it, so one shape can
 * serve several controls. Add an icon by adding an entry; `Icon` picks it up by name.
 */
import type { ReactElement } from "react";

export const ICON_PATHS = {
  /** A window with a pane on the left. */
  sidebar: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M6 3v10" />
    </>
  ),
  /** A window with a pane on the right. */
  panel: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M10 3v10" />
    </>
  ),
  /** A window with arrows pointing both ways. */
  "layout-auto": (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M5 8h6M6.5 6.2 4.7 8l1.8 1.8M9.5 6.2 11.3 8 9.5 9.8" />
    </>
  ),
  /** A window split into two columns. */
  "layout-split": (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M8 3v10" />
    </>
  ),
  /** A window with stacked lines. */
  "layout-unified": (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M5 6.5h6M5 9.5h6" />
    </>
  ),
  /** Two slider tracks with knobs. */
  sliders: (
    <>
      <path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6" />
      <circle cx="10" cy="5" r="1.5" />
      <circle cx="6" cy="11" r="1.5" />
    </>
  ),
  /** A circular arrow. */
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M13 3v2.6h-2.6" />
    </>
  ),
  /** Two chain links. */
  link: (
    <>
      <path d="M7 9a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.8.8" />
      <path d="M9 7a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.8-.8" />
    </>
  ),
  /** A magnifying glass. */
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="m10 10 3.5 3.5" />
    </>
  ),
  /** A chevron pointing down. */
  "chevron-down": <path d="m4 6 4 4 4-4" />,
  /** A chevron pointing right. */
  "chevron-right": <path d="m6 4 4 4-4 4" />,
  /** A chevron pointing up. */
  "chevron-up": <path d="m4 10 4-4 4 4" />,
  /** A check mark. */
  check: <path d="m3.5 8.5 3 3 6-7" />,
  /** A cross. */
  cross: <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />,
  /** A four-pointed spark, for an agent's avatar. */
  spark: <path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8 6.7 6.7z" />,
  /** A head and shoulders, for a person's avatar. */
  person: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5a5 5 0 0 1 10 0" />
    </>
  ),
  /** An arrow turning back. */
  reply: (
    <>
      <path d="M6.5 4 3 7.5 6.5 11" />
      <path d="M3 7.5h6a4 4 0 0 1 4 4v1" />
    </>
  ),
  /** A pencil. */
  pencil: <path d="M11 2.8 13.2 5 6 12.2l-3 .8.8-3z" />,
  /** A waste bin. */
  trash: (
    <>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5" />
      <path d="m4.5 4.5.6 8.5h5.8l.6-8.5" />
    </>
  ),
} satisfies Record<string, ReactElement>;

/** Every icon the page can draw. */
export type IconName = keyof typeof ICON_PATHS;
