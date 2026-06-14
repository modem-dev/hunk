import { mergeProps, Show, splitProps } from "solid-js";
import { HunkDiffBody } from "./HunkDiffBody";
import type { HunkDiffViewProps } from "./types";

/** Render one diff file body with an optional OpenTUI scrollbox wrapper. */
export function HunkDiffView(props: HunkDiffViewProps) {
  const merged = mergeProps({ scrollable: true }, props);
  // Pull `diff` and `scrollable` out so the remaining props forward straight onto
  // <HunkDiffBody> as its body props (everything except `file`).
  const [local, rest] = splitProps(merged, ["diff", "scrollable"]);

  return (
    <Show when={local.scrollable} fallback={<HunkDiffBody file={local.diff} {...rest} />}>
      <scrollbox width="100%" height="100%" scrollY={true} viewportCulling={true} focused={false}>
        <HunkDiffBody file={local.diff} {...rest} />
      </scrollbox>
    </Show>
  );
}
