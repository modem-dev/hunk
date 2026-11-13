/**
 * Binds the page commands that declare plain chords (`keys` in `../commands/webLocalCommands.ts`)
 * into the page's keyboard path.
 *
 * Identity, titles, and chords are declared once in `WEB_LOCAL_COMMANDS`, where the palette and
 * help read them; this module only wraps the ones with plain chords as `WebCommand`s the key
 * binding path matches (`../commands/keyboard.ts`), with their chords merged into the keymap
 * under any the host resolved, and runs each through the page's handler for its id.
 */
import { parseKeyChord } from "../../extension-api/keys";
import type { WebKeymap } from "../commands/keyboard";
import type { WebCommand } from "../commands/webCommandTable";
import { WEB_LOCAL_COMMANDS, type WebLocalCommandId } from "../commands/webLocalCommands";

/** The page commands with plain chords, as entries the key binding path matches. */
export function webLocalKeyCommands(run: (id: WebLocalCommandId) => void): WebCommand[] {
  return WEB_LOCAL_COMMANDS.flatMap((command): WebCommand[] =>
    "keys" in command
      ? [
          {
            entry: {
              id: command.id,
              title: command.title,
              category: command.category,
              defaultKeys: command.keys,
              locus: "client-local",
              publicToExtensions: false,
            },
            run: () => run(command.id),
          },
        ]
      : [],
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
 * The keymap with the page commands' plain chords under any the host resolved.
 *
 * The host's keymap is the user's: a page default whose chord the user bound to another
 * command loses it, so the user's binding keeps working and the page command stays in the
 * palette, unbound, rather than shadowing it or naming a key in a hint that does something else.
 */
export function withWebLocalChords(keymap: WebKeymap): WebKeymap {
  const merged = new Map(keymap);
  const taken = new Set(Array.from(keymap.values()).flatMap((chords) => chords.map(chordIdentity)));
  for (const command of WEB_LOCAL_COMMANDS) {
    if ("keys" in command && !merged.has(command.id)) {
      merged.set(
        command.id,
        command.keys.filter((chord) => !taken.has(chordIdentity(chord))),
      );
    }
  }
  return merged;
}
