import type { UserKeyBinding } from "../../core/types";
import { HUNK_VENDOR_EXTENSION_ID } from "../../extensions/extensionIds";
import { parseKeyChord, type ParsedKeyChord } from "../../lib/commandKeys";

/**
 * Resolve which chords each command answers to, defaults against user config.
 *
 * Bindings are an indirection, not a table of keys: commands declare the chords
 * they ship with, the user's `[keybindings]` table names command ids, and this
 * module folds the two into one answer per id. Everything downstream —
 * matchers, key labels, extension conflict detection — reads that answer, so
 * there is one source of truth for "what does this command respond to".
 *
 * The rule that makes remapping usable is exclusivity: a chord the user binds
 * explicitly belongs to that command, and any other command holding the same
 * chord *by default* quietly gives it up. Without that, rebinding `q` to
 * something else would leave the old owner still swallowing the key, and the
 * user would have to hunt down and unbind every default that collides.
 */

/** One command's shipped binding, as the command table declares it. */
export interface CommandKeyDefaults {
  id: string;
  /** Chords the command ships with; empty means it ships unbound. */
  defaultKeys: readonly string[];
}

/** Something wrong with the user's keybinding config, reported rather than thrown. */
export interface KeymapIssue {
  /** The command id the entry named, when the entry had one. */
  commandId?: string;
  message: string;
}

/** Chords per command id, plus everything worth telling the user about the config. */
export interface ResolvedKeymap {
  keys: Map<string, readonly string[]>;
  issues: KeymapIssue[];
}

export interface ResolveCommandKeysOptions {
  /** Every command that can be bound, in dispatch order. */
  defaults: readonly CommandKeyDefaults[];
  /** The user's `[keybindings]` table, in config order. */
  userBindings?: Readonly<Record<string, UserKeyBinding>>;
}

/**
 * Canonical spelling of a parsed chord, for comparing bindings.
 *
 * `"G"`, `"shift+g"`, and `"SHIFT+G"` are one chord; comparing the strings the
 * user typed would treat them as three. Modifier order is fixed so the
 * canonical form depends only on what the chord means.
 */
function canonicalizeChord(parsed: ParsedKeyChord) {
  return (
    `${parsed.ctrl ? "ctrl+" : ""}${parsed.meta ? "meta+" : ""}` +
    `${parsed.option ? "option+" : ""}${parsed.shift ? "shift+" : ""}${parsed.base}`
  );
}

/** Canonical form of one chord string, or nothing when it cannot be parsed. */
function canonicalizeChordString(chord: string) {
  const parsed = parseKeyChord(chord);
  return "error" in parsed ? undefined : canonicalizeChord(parsed);
}

/** The owner part of a command id: `hunk` for `hunk.app.quit`, `""` for a bare id. */
function commandOwner(id: string) {
  const dot = id.indexOf(".");
  return dot > 0 ? id.slice(0, dot) : "";
}

/**
 * Report whether an unknown id plausibly names a command that is simply absent.
 *
 * Every command id names its owner first — `hunk` for built-ins, the extension
 * id for everything else — and `hunk` is a reserved extension id, so the owner
 * segment classifies an unknown id structurally rather than by guesswork. An id
 * under `hunk.` can only be a typo, since Hunk's own table is fully known here.
 * An id under an extension this session loaded is a typo too. An id under an
 * extension nobody loaded is most likely a config shared across machines, not a
 * mistake, so it is reported softly.
 */
function namesAnAbsentExtension(id: string, knownOwners: ReadonlySet<string>) {
  const owner = commandOwner(id);
  return owner.length > 0 && owner !== HUNK_VENDOR_EXTENSION_ID && !knownOwners.has(owner);
}

/** Normalize one `[keybindings]` value into the chords it asks for. */
function toRequestedChords(binding: UserKeyBinding): readonly string[] {
  if (binding === false) {
    return [];
  }

  return typeof binding === "string" ? [binding] : [...binding];
}

/**
 * Fold user keybindings over the command table's defaults.
 *
 * A user entry replaces that command's defaults outright — bindings are
 * declarative, not additive, so what the config says is what the command
 * answers to. `false` (or an empty list) unbinds the command. Every chord a
 * user entry claims is then removed from any other command that held it by
 * default, leaving that command's remaining chords alone. Bad input never
 * throws: unknown ids, unparsable chords, and two entries fighting over one
 * chord come back as issues for the caller to surface, and the rest of the
 * config still applies.
 */
export function resolveCommandKeys({
  defaults,
  userBindings,
}: ResolveCommandKeysOptions): ResolvedKeymap {
  const issues: KeymapIssue[] = [];
  const keys = new Map<string, readonly string[]>();
  // Deduped table: reserved ids and first-wins loading make a repeated id
  // unreachable, but folding two entries into one would silently merge two
  // commands' keys, so the guard stays as the cheap backstop for that.
  const commands: CommandKeyDefaults[] = [];
  for (const command of defaults) {
    if (keys.has(command.id)) {
      issues.push({
        commandId: command.id,
        message: `Duplicate command id "${command.id}" ignored • the first registration keeps the keys`,
      });
      continue;
    }

    keys.set(command.id, command.defaultKeys);
    commands.push(command);
  }

  if (!userBindings) {
    return { keys, issues };
  }

  const known = new Set(commands.map((command) => command.id));
  const knownOwners = new Set(commands.map((command) => commandOwner(command.id)));
  // Canonical chord -> the user entry that claimed it; first entry in config order wins.
  const claimed = new Map<string, string>();
  const userChords = new Map<string, string[]>();

  for (const [commandId, binding] of Object.entries(userBindings)) {
    if (!known.has(commandId)) {
      issues.push({
        commandId,
        message: namesAnAbsentExtension(commandId, knownOwners)
          ? `Keybinding for "${commandId}" ignored • no command with that id is registered ` +
            "(the extension may not be loaded)"
          : `Keybinding for unknown command "${commandId}" ignored`,
      });
      continue;
    }

    const accepted: string[] = [];
    for (const chord of toRequestedChords(binding)) {
      const canonical = typeof chord === "string" ? canonicalizeChordString(chord) : undefined;
      if (canonical === undefined) {
        issues.push({
          commandId,
          message: `Keybinding "${String(chord)}" for "${commandId}" ignored • not a usable key chord`,
        });
        continue;
      }

      const owner = claimed.get(canonical);
      if (owner !== undefined) {
        issues.push({
          commandId,
          message: `Keybinding "${chord}" for "${commandId}" ignored • already bound to "${owner}"`,
        });
        continue;
      }

      claimed.set(canonical, commandId);
      accepted.push(chord);
    }

    userChords.set(commandId, accepted);
  }

  for (const [commandId, chords] of userChords) {
    keys.set(commandId, chords);
  }

  // Exclusivity: a chord the user bound is that command's alone, so strip it
  // from every command that only held it as a default.
  for (const command of commands) {
    if (userChords.has(command.id)) {
      continue;
    }

    const kept = command.defaultKeys.filter((chord) => {
      const canonical = canonicalizeChordString(chord);
      return canonical === undefined || claimed.get(canonical) === undefined;
    });
    if (kept.length !== command.defaultKeys.length) {
      keys.set(command.id, kept);
    }
  }

  return { keys, issues };
}

const NAMED_CHORD_LABELS: Record<string, string> = {
  escape: "Esc",
  pageup: "PageUp",
  pagedown: "PageDown",
  space: "Space",
  backspace: "Backspace",
  insert: "Insert",
  delete: "Delete",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
};

/** Title-case one chord token for display (`pageup` -> `PageUp`, `f2` -> `F2`). */
function formatChordBase(base: string) {
  const named = NAMED_CHORD_LABELS[base];
  if (named) {
    return named;
  }

  if (/^f\d{1,2}$/.test(base)) {
    return base.toUpperCase();
  }

  // Single characters are shown exactly as typed; `G` keeps its shifted form.
  return base;
}

/**
 * Render one chord for menus, help, and conflict messages.
 *
 * Labels are derived from the resolved binding rather than written by hand, so
 * a remapped command advertises the key it actually answers to.
 */
export function formatKeyChord(chord: string): string {
  const parsed = parseKeyChord(chord);
  if ("error" in parsed) {
    return chord;
  }

  const isLetter = /^[a-z]$/.test(parsed.base);
  const modifiers = [
    parsed.ctrl ? "Ctrl" : undefined,
    parsed.meta ? "Cmd" : undefined,
    parsed.option ? "Alt" : undefined,
    // A shifted letter reads as its uppercase form, the way it is typed and
    // the way the chord grammar spells it; every other shifted key names the
    // modifier instead.
    parsed.shift && !isLetter ? "Shift" : undefined,
  ].filter((modifier): modifier is string => modifier !== undefined);
  // A bare letter is shown exactly as typed ("q"); combined with a modifier it
  // reads as a named key would ("Ctrl+M"), which is how keyboards label them.
  const base =
    isLetter && (parsed.shift || modifiers.length > 0)
      ? parsed.base.toUpperCase()
      : formatChordBase(parsed.base);

  return [...modifiers, base].join("+");
}
