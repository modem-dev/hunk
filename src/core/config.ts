import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CliInput, CommonOptions, LayoutMode, PersistedViewPreferences } from "./types";

const CONFIG_SECTION_NAMES = ["pager", "git", "diff", "patch", "difftool"] as const;
const DEFAULT_VIEW_PREFERENCES: PersistedViewPreferences = {
  mode: "auto",
  showLineNumbers: true,
  wrapLines: false,
  showHunkHeaders: true,
  showAgentNotes: false,
};

interface ConfigResolutionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface HunkConfigResolution {
  input: CliInput;
  globalConfigPath?: string;
  repoConfigPath?: string;
  persistencePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept only the layout names Hunk already supports. */
function normalizeLayoutMode(value: unknown): LayoutMode | undefined {
  return value === "auto" || value === "split" || value === "stack" ? value : undefined;
}

/** Accept only plain booleans from config files. */
function normalizeBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

/** Accept only plain strings from config files. */
function normalizeString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read the view preferences stored at one TOML object level. */
function readConfigPreferences(source: Record<string, unknown>): CommonOptions {
  return {
    mode: normalizeLayoutMode(source.mode),
    theme: normalizeString(source.theme),
    lineNumbers: normalizeBoolean(source.line_numbers),
    wrapLines: normalizeBoolean(source.wrap_lines),
    hunkHeaders: normalizeBoolean(source.hunk_headers),
    agentNotes: normalizeBoolean(source.agent_notes),
  };
}

/** Merge partial preference layers with right-hand overrides taking precedence. */
function mergeOptions(base: CommonOptions, overrides: CommonOptions): CommonOptions {
  return {
    ...base,
    mode: overrides.mode ?? base.mode,
    theme: overrides.theme ?? base.theme,
    agentContext: overrides.agentContext ?? base.agentContext,
    pager: overrides.pager ?? base.pager,
    lineNumbers: overrides.lineNumbers ?? base.lineNumbers,
    wrapLines: overrides.wrapLines ?? base.wrapLines,
    hunkHeaders: overrides.hunkHeaders ?? base.hunkHeaders,
    agentNotes: overrides.agentNotes ?? base.agentNotes,
  };
}

/** Apply one parsed config object, including command/pager sections, to the current invocation. */
function resolveConfigLayer(source: Record<string, unknown>, input: CliInput): CommonOptions {
  let resolved = readConfigPreferences(source);

  const commandSection = source[input.kind];
  if (isRecord(commandSection)) {
    resolved = mergeOptions(resolved, readConfigPreferences(commandSection));
  }

  const pagerSection = source.pager;
  if (input.options.pager && isRecord(pagerSection)) {
    resolved = mergeOptions(resolved, readConfigPreferences(pagerSection));
  }

  return resolved;
}

/** Return the first parent that looks like a Git repository root. */
function findRepoRoot(cwd = process.cwd()) {
  let current = resolve(cwd);

  for (;;) {
    if (fs.existsSync(join(current, ".git"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

/** Resolve the global XDG-style config path, if the environment provides one. */
function globalConfigPath(env: NodeJS.ProcessEnv = process.env) {
  if (env.XDG_CONFIG_HOME) {
    return join(env.XDG_CONFIG_HOME, "hunk", "config.toml");
  }

  if (env.HOME) {
    return join(env.HOME, ".config", "hunk", "config.toml");
  }

  return undefined;
}

/** Parse one TOML config file into a plain object. */
function readTomlRecord(path: string) {
  if (!fs.existsSync(path)) {
    return {};
  }

  const parsed = Bun.TOML.parse(fs.readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`Expected ${path} to contain a TOML object.`);
  }

  return parsed;
}

/** Resolve CLI input against global and repo-local config files. */
export function resolveConfiguredCliInput(
  input: CliInput,
  { cwd = process.cwd(), env = process.env }: ConfigResolutionOptions = {},
): HunkConfigResolution {
  const repoRoot = findRepoRoot(cwd);
  const repoConfigPath = repoRoot ? join(repoRoot, ".hunk", "config.toml") : undefined;
  const userConfigPath = globalConfigPath(env);

  let resolvedOptions: CommonOptions = {
    mode: DEFAULT_VIEW_PREFERENCES.mode,
    theme: undefined,
    agentContext: input.options.agentContext,
    pager: input.options.pager ?? false,
    lineNumbers: DEFAULT_VIEW_PREFERENCES.showLineNumbers,
    wrapLines: DEFAULT_VIEW_PREFERENCES.wrapLines,
    hunkHeaders: DEFAULT_VIEW_PREFERENCES.showHunkHeaders,
    agentNotes: DEFAULT_VIEW_PREFERENCES.showAgentNotes,
  };

  if (userConfigPath) {
    resolvedOptions = mergeOptions(resolvedOptions, resolveConfigLayer(readTomlRecord(userConfigPath), input));
  }

  if (repoConfigPath) {
    resolvedOptions = mergeOptions(resolvedOptions, resolveConfigLayer(readTomlRecord(repoConfigPath), input));
  }

  resolvedOptions = mergeOptions(resolvedOptions, input.options);
  resolvedOptions = {
    ...resolvedOptions,
    agentContext: input.options.agentContext,
    pager: input.options.pager ?? false,
    mode: resolvedOptions.mode ?? DEFAULT_VIEW_PREFERENCES.mode,
    lineNumbers: resolvedOptions.lineNumbers ?? DEFAULT_VIEW_PREFERENCES.showLineNumbers,
    wrapLines: resolvedOptions.wrapLines ?? DEFAULT_VIEW_PREFERENCES.wrapLines,
    hunkHeaders: resolvedOptions.hunkHeaders ?? DEFAULT_VIEW_PREFERENCES.showHunkHeaders,
    agentNotes: resolvedOptions.agentNotes ?? DEFAULT_VIEW_PREFERENCES.showAgentNotes,
  };

  return {
    input: {
      ...input,
      options: resolvedOptions,
    },
    globalConfigPath: userConfigPath,
    repoConfigPath,
    persistencePath: repoConfigPath ?? userConfigPath,
  };
}

/** Return whether an array contains only TOML table objects. */
function isRecordArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isRecord);
}

/** Serialize one inline TOML value, including scalar arrays. */
function serializeTomlValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value) && !isRecordArray(value)) {
    const serializedItems = value.map((item) => serializeTomlValue(item));
    if (serializedItems.some((item) => item === undefined)) {
      return undefined;
    }

    return `[${serializedItems.join(", ")}]`;
  }

  return undefined;
}

/** Render one TOML object recursively while keeping scalar keys above child tables. */
function serializeTomlObject(source: Record<string, unknown>, sectionName?: string, arrayTable = false): string[] {
  const lines: string[] = [];
  const scalarEntries: Array<[string, string]> = [];
  const tableEntries: Array<[string, Record<string, unknown>]> = [];
  const arrayTableEntries: Array<[string, Array<Record<string, unknown>>]> = [];

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }

    if (isRecord(value)) {
      tableEntries.push([key, value]);
      continue;
    }

    if (isRecordArray(value)) {
      arrayTableEntries.push([key, value]);
      continue;
    }

    const serialized = serializeTomlValue(value);
    if (serialized !== undefined) {
      scalarEntries.push([key, serialized]);
    }
  }

  if (sectionName) {
    lines.push(`${arrayTable ? "[[" : "["}${sectionName}${arrayTable ? "]]" : "]"}`);
  }

  for (const [key, value] of scalarEntries) {
    lines.push(`${key} = ${value}`);
  }

  for (const [key, value] of tableEntries) {
    if (lines.length > 0) {
      lines.push("");
    }

    lines.push(...serializeTomlObject(value, sectionName ? `${sectionName}.${key}` : key));
  }

  for (const [key, values] of arrayTableEntries) {
    for (const value of values) {
      if (lines.length > 0) {
        lines.push("");
      }

      lines.push(...serializeTomlObject(value, sectionName ? `${sectionName}.${key}` : key, true));
    }
  }

  return lines;
}

/** Persist the current view defaults while preserving any existing profile sections. */
export function persistViewPreferences(path: string, preferences: PersistedViewPreferences) {
  const existing = readTomlRecord(path);

  existing.mode = preferences.mode;
  existing.line_numbers = preferences.showLineNumbers;
  existing.wrap_lines = preferences.wrapLines;
  existing.hunk_headers = preferences.showHunkHeaders;
  existing.agent_notes = preferences.showAgentNotes;

  if (preferences.theme) {
    existing.theme = preferences.theme;
  } else {
    delete existing.theme;
  }

  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, `${serializeTomlObject(existing).join("\n").trim()}\n`);
}

export const CONFIG_DEFAULTS = DEFAULT_VIEW_PREFERENCES;
export const CONFIG_SECTION_KEYS = CONFIG_SECTION_NAMES;
