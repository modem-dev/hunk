import type { HunkDiffLayout, LegacyHunkDiffLayout } from "./types";

/** Canonical layout vocabulary consumed by Hunk's renderer. */
export type CanonicalHunkDiffLayout = Exclude<HunkDiffLayout, LegacyHunkDiffLayout>;

/** Normalize the deprecated public `stack` prop before it reaches renderer state. */
export function normalizeHunkDiffLayout(layout: HunkDiffLayout): CanonicalHunkDiffLayout {
  return layout === "stack" ? "unified" : layout;
}
