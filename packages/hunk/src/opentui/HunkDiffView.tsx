import { HunkDiffBody } from "./HunkDiffBody";
import type { HunkDiffViewProps } from "./types";

/** Render one diff file body with an optional OpenTUI scrollbox wrapper. */
export function HunkDiffView({ diff, scrollable = true, ...props }: HunkDiffViewProps) {
  const content = <HunkDiffBody file={diff} {...props} />;

  if (!scrollable) {
    return content;
  }

  return (
    <scrollbox width="100%" height="100%" scrollY={true} viewportCulling={true} focused={false}>
      {content}
    </scrollbox>
  );
}
