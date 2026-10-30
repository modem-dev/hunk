import type { CliRenderer } from "@opentui/core";
import { useLayoutEffect, useRef, type DependencyList } from "react";

/** Request an intermediate redraw only after a component's initial committed layout. */
export function useIntermediateRenderAfterMount(
  renderer: Pick<CliRenderer, "intermediateRender">,
  dependencies: DependencyList,
  skipInitial = true,
) {
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      if (skipInitial) return;
    }
    renderer.intermediateRender();
  }, [renderer, skipInitial, ...dependencies]);
}
