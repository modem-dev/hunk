/**
 * Matches and labels the Ctrl/Cmd chords the page claims from the browser, and re-exports the
 * page's own command declaration for the modules beside it.
 *
 * The commands themselves (`hunk.web.*`) are declared once in
 * `core/run/webLocalCommandCatalog.ts`, where the host reads them too: it resolves a
 * `[keybindings]` entry for one and publishes the result in the review's keymap. The palette,
 * the help overlay, and the page's keyboard read that list beside the shared catalog.
 *
 * The two dialog chords are deliberate browser chords (Ctrl/Cmd+K, Ctrl/Cmd+P): the shared
 * grammar masks every modified chord on the page so the browser keeps its shortcuts, and these
 * two are the exceptions the page claims, matched here rather than through the keymap. Every
 * other page command binds through the page's keymap like a catalog command
 * (`../panel/panelCommands.ts`); a plain default must not collide with a catalog default
 * (`../panel/panelCommands.test.ts`).
 */
import { WEB_LOCAL_COMMANDS, type WebLocalCommandId } from "../../core/run/webLocalCommandCatalog";

export {
  WEB_LOCAL_COMMANDS,
  type WebLocalCommand,
  type WebLocalCommandCategory,
  type WebLocalCommandId,
} from "../../core/run/webLocalCommandCatalog";

/** True on Apple platforms, where the page's chords use Cmd instead of Ctrl. */
export function isApplePlatform(platform = globalThis.navigator?.platform ?? "") {
  return /Mac|iPhone|iPad/.test(platform);
}

/** The label of one page chord, in the platform's spelling. */
export function webModChordLabel(key: string, apple = isApplePlatform()) {
  return apple ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}

/** The page command a modified key event claims, if any. */
export function matchWebLocalChord(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): WebLocalCommandId | undefined {
  const mod = event.ctrlKey || event.metaKey;
  if (!mod || event.altKey || event.shiftKey) return undefined;
  const key = event.key.toLowerCase();
  const command = WEB_LOCAL_COMMANDS.find(
    (candidate) => "modKey" in candidate && candidate.modKey === key,
  );
  return command?.id;
}
