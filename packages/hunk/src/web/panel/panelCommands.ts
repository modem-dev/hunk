/**
 * Binds the page's remappable commands (`hunk.web.*`, every one but the two Ctrl/Cmd dialog
 * chords) into the page's keyboard path.
 *
 * Identity, titles, and shipped chords are declared once in `WEB_LOCAL_COMMANDS`, where the
 * palette and help read them; this module wraps each remappable one as a `WebCommand` the key
 * binding path matches (`../commands/keyboard.ts`) and runs it through the page's handler for
 * its id. Which chords each answers to comes from the host's resolved keymap, which folds the
 * user's `[keybindings]` over these commands beside the catalog; a command that ships without
 * a chord binds as soon as the user gives it one.
 */
import { parseKeyChord } from "../../extension-api/keys";
import { WEB_LOCAL_COMMAND_KEY_DEFAULTS } from "../../core/run/webLocalCommandCatalog";
import type { WebKeymap } from "../commands/keyboard";
import type { WebCommand } from "../commands/webCommandTable";
import { WEB_LOCAL_COMMANDS, type WebLocalCommandId } from "../commands/webLocalCommands";

/** The remappable page commands, as entries the key binding path matches. */
export function webLocalKeyCommands(run: (id: WebLocalCommandId) => void): WebCommand[] {
  return WEB_LOCAL_COMMANDS.flatMap((command): WebCommand[] =>
    "modKey" in command
      ? []
      : [
          {
            entry: {
              id: command.id,
              title: command.title,
              category: command.category,
              defaultKeys: "keys" in command ? command.keys : [],
              locus: "client-local",
              publicToExtensions: false,
            },
            run: () => run(command.id),
          },
        ],
  );
}

/** One chord's identity, so `O` and `shift+o` count as the same key. */
function chordIdentity(chord: string) {
  const parsed = parseKeyChord(chord);
  if ("error" in parsed) return undefined;
  const letter = parsed.base.length === 1 && parsed.base.toLowerCase() !== parsed.base;
  return [
    parsed.ctrl,
    parsed.meta,
    parsed.option,
    parsed.shift || letter,
    parsed.base.toLowerCase(),
  ].join(":");
}

/**
 * The keymap with the page commands' shipped chords under any the host resolved.
 *
 * A host that resolves page commands publishes an entry for each, and that entry is the
 * answer: its chords are the user's remap, an empty list is an unbind, and nothing here adds
 * to it. The shipped chords fill in only for an id the keymap does not carry, which is the
 * catalog's defaults before the shared state arrives and a host from before it published page
 * commands. There a page default whose chord another command already holds gives it up, so the
 * held binding keeps working and no hint names a key that does something else.
 */
export function withWebLocalChords(keymap: WebKeymap): WebKeymap {
  const merged = new Map(keymap);
  const taken = new Set(Array.from(keymap.values()).flatMap((chords) => chords.map(chordIdentity)));
  for (const command of WEB_LOCAL_COMMAND_KEY_DEFAULTS) {
    if (!merged.has(command.id)) {
      merged.set(
        command.id,
        command.defaultKeys.filter((chord) => !taken.has(chordIdentity(chord))),
      );
    }
  }
  return merged;
}
