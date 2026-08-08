import { renderStaticDiff as renderStaticDiffInternal } from "../ui/staticDiffPager";
import type { StaticDiffOptions } from "./types.js";

export type { StaticDiffOptions } from "./types.js";

/** Render a unified patch as ANSI text without starting Hunk's interactive application. */
export const renderStaticDiff = (text: string, options: StaticDiffOptions = {}): Promise<string> =>
  renderStaticDiffInternal(text, options);
