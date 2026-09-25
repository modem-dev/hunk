import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type {
  ExtensionReviewPresentationControls,
  ExtensionReviewPresentationScope,
} from "../../extension-api/types";
import type { ExtensionLoadResult } from "../../extensions/types";
import type { DiffFile } from "../../core/changeset/model";
import {
  createExtensionPresentationScopeStore,
  type ExtensionPresentationScopeStore,
} from "../lib/extensionPresentationScope";

/** Keep extension-owned presentation scopes transient across reloads and registry retirement. */
export function useExtensionPresentationScope({
  extensions,
  files,
  getGeneration,
}: {
  extensions?: ExtensionLoadResult;
  files: readonly DiffFile[];
  getGeneration: () => string | null;
}) {
  const filesRef = useRef(files);
  filesRef.current = files;
  const generationRef = useRef(getGeneration);
  generationRef.current = getGeneration;
  const [, setChange] = useState(0);
  const storeRef = useRef<ExtensionPresentationScopeStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createExtensionPresentationScopeStore({
      getGeneration: () => generationRef.current(),
      getFiles: () => filesRef.current,
      onChange: () => setChange((value) => value + 1),
    });
  }
  const store = storeRef.current;
  const registry = extensions?.registry;
  const generation = getGeneration();
  // Registry results may be recreated while the same extension lifecycle remains mounted.
  // Derive a value from stable ownership facts instead of depending on the registry object so a
  // pane re-render cannot clear its own scope and trigger a clear/reapply loop.
  const registryLifecycleKey = registry
    ? `${registry.eventBusPhase}:${registry.extensions.map((entry) => `${entry.id}:${entry.sourcePath}:${entry.origin}`).join("\u0000")}`
    : "none";

  useLayoutEffect(() => {
    store.clearAll();
  }, [generation, registryLifecycleKey, store]);

  const clearExtensionScope = useCallback(
    (extensionId: string) => store.clear(extensionId),
    [store],
  );
  const createControls = useCallback(
    (extensionId: string): ExtensionReviewPresentationControls => ({
      setPresentationScope(scope: ExtensionReviewPresentationScope) {
        return store.set(extensionId, scope);
      },
      clearPresentationScope() {
        store.clear(extensionId);
      },
    }),
    [store],
  );

  return {
    scope: store.get(),
    createControls,
    clearExtensionScope,
  };
}
