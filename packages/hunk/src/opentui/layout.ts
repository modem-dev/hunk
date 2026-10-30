import type { CanonicalHunkDiffLayout, HunkDiffLayout } from "./types";

/** Normalize the deprecated public `stack` prop before it reaches renderer state. */
export function normalizeHunkDiffLayout(
  layout: HunkDiffLayout | CanonicalHunkDiffLayout,
): CanonicalHunkDiffLayout {
  return layout === "stack" ? "unified" : layout;
}
