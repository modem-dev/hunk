import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalThemeMode } from "../../core/theme/detection";
import type { NamedCustomThemeConfig } from "../../extension-api/types";
import type { ThemeSelectorItem } from "../components/chrome/ThemeSelectorDialog";
import { availableThemes, resolveTheme, withTransparentSurfaces } from "../themes";

interface ThemeSelectorControllerState {
  committedThemeId: string;
  open: boolean;
  previewThemeId: string | null;
  selectedThemeId: string | null;
}

export interface UseThemeSelectorControllerOptions {
  customThemes?: readonly NamedCustomThemeConfig[];
  initialTheme?: string;
  initialThemeMode?: TerminalThemeMode | null;
  onTransientNotice: (text: string) => void;
  /** Observe committed choices so a remounting surface can retain them. */
  onThemeCommitted?: (themeId: string) => void;
  transparentBackground: boolean;
}

/** Drive theme resolution, committed selection, and transient selector previews. */
export function useThemeSelectorController({
  customThemes,
  initialTheme,
  initialThemeMode,
  onTransientNotice,
  onThemeCommitted,
  transparentBackground,
}: UseThemeSelectorControllerOptions) {
  // Startup detection is launch state. Soft bootstrap reloads may replace the
  // incoming record, but they must not reinterpret an in-session theme choice.
  const [detectedThemeMode] = useState(initialThemeMode);
  const [state, setState] = useState<ThemeSelectorControllerState>(() => ({
    committedThemeId: resolveTheme(initialTheme, initialThemeMode ?? null, customThemes).id,
    open: false,
    previewThemeId: null,
    selectedThemeId: null,
  }));

  const themeOptions = useMemo(() => availableThemes(customThemes), [customThemes]);
  const committedTheme = useMemo(
    () => resolveTheme(state.committedThemeId, detectedThemeMode ?? null, customThemes),
    [customThemes, detectedThemeMode, state.committedThemeId],
  );
  const committedIndex = themeOptions.findIndex((theme) => theme.id === committedTheme.id);
  const storedSelectedIndex = themeOptions.findIndex((theme) => theme.id === state.selectedThemeId);
  const selectedIndex =
    storedSelectedIndex >= 0 ? storedSelectedIndex : committedIndex >= 0 ? committedIndex : 0;
  const selectedThemeId = themeOptions[selectedIndex]?.id ?? null;
  const selectedThemeIdRef = useRef(selectedThemeId);
  selectedThemeIdRef.current = selectedThemeId;

  const previewThemeId = themeOptions.some((theme) => theme.id === state.previewThemeId)
    ? state.previewThemeId
    : null;
  const baseTheme = useMemo(
    () =>
      previewThemeId
        ? resolveTheme(previewThemeId, detectedThemeMode ?? null, customThemes)
        : committedTheme,
    [committedTheme, customThemes, detectedThemeMode, previewThemeId],
  );
  const activeTheme = useMemo(
    () => (transparentBackground ? withTransparentSurfaces(baseTheme) : baseTheme),
    [baseTheme, transparentBackground],
  );
  const items = useMemo<ThemeSelectorItem[]>(
    () =>
      themeOptions.map((theme) => ({
        id: theme.id,
        label: theme.label,
        description: theme.id === baseTheme.id ? "active" : "",
        active: theme.id === baseTheme.id,
      })),
    [baseTheme.id, themeOptions],
  );

  // Catalog replacement can remove a selected or previewed custom theme. Clear
  // those transient identities while retaining the raw committed preference.
  useEffect(() => {
    setState((current) => {
      const availableIds = new Set(themeOptions.map((theme) => theme.id));
      const nextSelectedThemeId =
        current.selectedThemeId !== null && availableIds.has(current.selectedThemeId)
          ? current.selectedThemeId
          : selectedThemeId;
      const nextPreviewThemeId =
        current.previewThemeId !== null && availableIds.has(current.previewThemeId)
          ? current.previewThemeId
          : null;

      if (
        current.selectedThemeId === nextSelectedThemeId &&
        current.previewThemeId === nextPreviewThemeId
      ) {
        return current;
      }

      return {
        ...current,
        previewThemeId: nextPreviewThemeId,
        selectedThemeId: nextSelectedThemeId,
      };
    });
  }, [selectedThemeId, themeOptions]);

  /** Open the selector on the resolved committed theme without starting a preview. */
  const openThemeSelector = useCallback(() => {
    selectedThemeIdRef.current = committedTheme.id;
    setState((current) => ({
      ...current,
      open: true,
      previewThemeId: null,
      selectedThemeId: committedTheme.id,
    }));
  }, [committedTheme.id]);

  /** Cancel the selector and restore the committed theme projection. */
  const closeThemeSelector = useCallback(() => {
    setState((current) => ({ ...current, open: false, previewThemeId: null }));
  }, []);

  /** Move the selector with wraparound and preview the resulting identity. */
  const moveThemeSelector = useCallback(
    (delta: number) => {
      if (themeOptions.length === 0) {
        selectedThemeIdRef.current = null;
        setState((current) => ({
          ...current,
          previewThemeId: null,
          selectedThemeId: null,
        }));
        return;
      }

      const currentIndex = themeOptions.findIndex(
        (theme) => theme.id === selectedThemeIdRef.current,
      );
      const anchorIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex =
        (((anchorIndex + delta) % themeOptions.length) + themeOptions.length) % themeOptions.length;
      const nextThemeId = themeOptions[nextIndex]!.id;
      selectedThemeIdRef.current = nextThemeId;
      setState((current) => ({
        ...current,
        previewThemeId: nextThemeId,
        selectedThemeId: nextThemeId,
      }));
    },
    [themeOptions],
  );

  /** Preview one pointer-highlighted item without changing the committed identity. */
  const previewThemeSelectorItem = useCallback(
    (index: number) => {
      const item = themeOptions[index];
      if (!item) return;

      selectedThemeIdRef.current = item.id;
      setState((current) => ({
        ...current,
        previewThemeId: item.id,
        selectedThemeId: item.id,
      }));
    },
    [themeOptions],
  );

  /** Commit one validated item and clear its preview without an intermediate theme. */
  const commitThemeSelectorItem = useCallback(
    (item: (typeof themeOptions)[number]) => {
      selectedThemeIdRef.current = item.id;
      setState((current) => ({
        ...current,
        committedThemeId: item.id,
        open: false,
        previewThemeId: null,
        selectedThemeId: item.id,
      }));
      onThemeCommitted?.(item.id);
      onTransientNotice(`Theme: ${item.label}`);
    },
    [onThemeCommitted, onTransientNotice],
  );

  /** Commit one pointer-selected item when its current catalog entry is valid. */
  const acceptThemeSelectorItem = useCallback(
    (index: number) => {
      const item = themeOptions[index];
      if (item) commitThemeSelectorItem(item);
    },
    [commitThemeSelectorItem, themeOptions],
  );

  /** Commit the latest highlighted identity, including movement batched before acceptance. */
  const acceptThemeSelector = useCallback(() => {
    const item = themeOptions.find((theme) => theme.id === selectedThemeIdRef.current);
    if (item) commitThemeSelectorItem(item);
  }, [commitThemeSelectorItem, themeOptions]);

  return {
    activeTheme,
    baseTheme,
    themeId: state.committedThemeId,
    themeSelectorItems: items,
    themeSelectorOpen: state.open,
    themeSelectorSelectedIndex: selectedIndex,
    acceptThemeSelector,
    acceptThemeSelectorItem,
    closeThemeSelector,
    moveThemeSelector,
    openThemeSelector,
    previewThemeSelectorItem,
  };
}
