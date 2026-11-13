/**
 * Runs the page's commands from the keyboard.
 *
 * One window-level listener matches each key against the bound chords in catalog order and
 * runs the first command that answers, the way the terminal's dispatch loop does. It stays
 * out of the way of everything the browser or a focused control owns (see `keyboard.ts`): a
 * key some widget already handled (`defaultPrevented`), a key typed into a field, Space or
 * Enter on a button, and every Ctrl, Cmd, or Alt chord. A key the page runs is consumed, so
 * Space pages the review instead of also scrolling natively.
 */
import { useEffect, useMemo, useRef } from "react";
import { bindWebCommands, focusOwnsKey, webKeyEvent, type WebKeymap } from "./keyboard";
import type { WebCommand } from "./webCommandTable";

/** Listen for the page's shortcuts while mounted. */
export function useWebKeyboard(commands: readonly WebCommand[], keymap: WebKeymap) {
  const bindings = useMemo(() => bindWebCommands(commands, keymap), [commands, keymap]);
  const latest = useRef(bindings);
  latest.current = bindings;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const key = webKeyEvent(event);
      if (!key) return;
      if (focusOwnsKey(event.composedPath(), key)) return;
      const command = latest.current.match(key);
      if (!command) return;
      event.preventDefault();
      command.run({ count: 1, shift: event.shiftKey });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
