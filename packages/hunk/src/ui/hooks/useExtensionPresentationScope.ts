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
  const activeRegistryRef = useRef(registry);
  activeRegistryRef.current = registry;
  const generation = getGeneration();

  // A load result can be recreated without retiring its registry. A replacement registry,
  // even with identical extension metadata, owns a new lifecycle and no previous scopes.
  useLayoutEffect(() => {
    store.clearAll();
  }, [generation, registry, store]);

  const clearExtensionScope = useCallback(
    (extensionId: string) => store.clear(extensionId),
    [store],
  );
  const createControls = useCallback(
    (extensionId: string): ExtensionReviewPresentationControls => {
      const owner = activeRegistryRef.current;
      return {
        setPresentationScope(scope: ExtensionReviewPresentationScope) {
          return (
            owner !== undefined &&
            owner === activeRegistryRef.current &&
            store.set(extensionId, scope)
          );
        },
        clearPresentationScope() {
          if (owner === activeRegistryRef.current) store.clear(extensionId);
        },
      };
    },
    [store],
  );

  return {
    scope: store.get(),
    createControls,
    clearExtensionScope,
  };
}
