/**
 * Resolve which chords each command answers to, defaults against user config.
 *
 * Bindings are an indirection, not a table of keys: commands declare the chords
 * they ship with, the user's `[keybindings]` table names command ids, and this
 * module folds the two into one answer per id. Everything downstream —
 * matchers, key labels, extension conflict detection, and the keymap a review
 * session publishes to a browser — reads that answer, so there is one source of
 * truth for "what does this command respond to".
 *
 * The rule that makes remapping usable is exclusivity: a chord the user binds
 * explicitly belongs to that command, and any other command holding the same
 * chord *by default* quietly gives it up. Without that, rebinding `q` to
 * something else would leave the old owner still swallowing the key, and the
 * user would have to hunt down and unbind every default that collides.
 */
import type { UserKeyBinding } from "./config";
import { parseKeyChord, type ParsedKeyChord } from "../../lib/commandKeys";

/**
 * The command namespace Hunk reserves for itself.
 *
 * The same id `extensions/extensionIds.ts` reserves as `HUNK_VENDOR_EXTENSION_ID`; core may not
 * import the extension host, and `keymap.test.ts` asserts the two stay equal.
 */
export const HUNK_COMMAND_OWNER = "hunk";

/** One command's shipped binding, as the command table declares it. */
export interface CommandKeyDefaults {
  id: string;
  /** Deprecated ids accepted anywhere callers name this command. */
  aliases?: readonly string[];
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

const NO_KEY_CHORDS: readonly string[] = Object.freeze([]);

export interface ResolveCommandKeysOptions {
  /** Every command active on this surface, in dispatch order. */
  defaults: readonly CommandKeyDefaults[];
  /** Known commands owned by another surface; accepted but inactive here. */
  inactiveCommandNames?: ReadonlySet<string>;
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
  return owner.length > 0 && owner !== HUNK_COMMAND_OWNER && !knownOwners.has(owner);
}

/** Normalize one `[keybindings]` value into the chords it asks for. */
function toRequestedChords(binding: UserKeyBinding): readonly string[] {
  if (binding === false) {
    return [];
  }

  return typeof binding === "string" ? [binding] : [...binding];
}

/** Mirror canonical bindings onto compatibility aliases for injected key lookup. */
function mirrorCommandAliases(
  keys: Map<string, readonly string[]>,
  commands: readonly CommandKeyDefaults[],
  canonicalByName: ReadonlyMap<string, string>,
) {
  for (const command of commands) {
    const chords = keys.get(command.id) ?? NO_KEY_CHORDS;
    for (const alias of command.aliases ?? []) {
      if (canonicalByName.get(alias) === command.id) keys.set(alias, chords);
    }
  }
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
  inactiveCommandNames,
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

  const canonicalByName = new Map(commands.map((command) => [command.id, command.id]));
  for (const command of commands) {
    for (const alias of command.aliases ?? []) {
      const existing = canonicalByName.get(alias);
      if (existing !== undefined) {
        issues.push({
          commandId: alias,
          message: `Duplicate command alias "${alias}" ignored • already resolves to "${existing}"`,
        });
        continue;
      }
      canonicalByName.set(alias, command.id);
    }
  }

  if (!userBindings) {
    mirrorCommandAliases(keys, commands, canonicalByName);
    return { keys, issues };
  }

  const knownOwners = new Set(commands.map((command) => commandOwner(command.id)));
  // Canonical chord -> the user entry that claimed it; first entry in config order wins.
  const claimed = new Map<string, string>();
  const userChords = new Map<string, string[]>();
  const configuredBy = new Map<string, string>();

  for (const [commandId, binding] of Object.entries(userBindings)) {
    const canonicalId = canonicalByName.get(commandId);
    if (canonicalId === undefined) {
      if (inactiveCommandNames?.has(commandId)) {
        continue;
      }
      issues.push({
        commandId,
        message: namesAnAbsentExtension(commandId, knownOwners)
          ? `Keybinding for "${commandId}" ignored • no command with that id is registered ` +
            "(the extension may not be loaded)"
          : `Keybinding for unknown command "${commandId}" ignored`,
      });
      continue;
    }

    const previousName = configuredBy.get(canonicalId);
    if (previousName !== undefined) {
      issues.push({
        commandId,
        message: `Keybinding for "${commandId}" ignored • "${previousName}" already configures "${canonicalId}"`,
      });
      continue;
    }
    configuredBy.set(canonicalId, commandId);

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

    userChords.set(canonicalId, accepted);
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

  mirrorCommandAliases(keys, commands, canonicalByName);
  return { keys, issues };
}
