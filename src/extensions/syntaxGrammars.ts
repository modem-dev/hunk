import type {
  ExtensionSyntaxGrammar,
  ExtensionSyntaxGrammarCapture,
  ExtensionSyntaxGrammarRule,
} from "../extension-api/types";

/** Bounds extension grammar input before it reaches the highlighting worker. */
export const SYNTAX_GRAMMAR_LIMITS = Object.freeze({
  bytes: 256 * 1024,
  depth: 32,
  nodes: 10_000,
  stringLength: 32_768,
  grammarsPerExtension: 16,
  grammarsPerSession: 64,
});

const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const SCOPE_PATTERN = /^(?:source|text)\.[a-z0-9_.-]+$/;
const RULE_KEYS = new Set([
  "include",
  "name",
  "contentName",
  "match",
  "begin",
  "end",
  "while",
  "captures",
  "beginCaptures",
  "endCaptures",
  "whileCaptures",
  "patterns",
  "applyEndPatternLast",
]);
const CAPTURE_KEYS = new Set(["name", "contentName", "patterns"]);
const GRAMMAR_KEYS = new Set(["id", "scopeName", "patterns", "repository"]);

/** Report whether one unknown value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject unknown object keys so the public subset stays closed. */
function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`registerSyntaxGrammar does not support ${where}.${key}.`);
    }
  }
}

/** Copy one bounded string. */
function copyString(value: unknown, where: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`registerSyntaxGrammar requires ${where} to be a non-empty string.`);
  }
  if (value.length > SYNTAX_GRAMMAR_LIMITS.stringLength) {
    throw new Error(`registerSyntaxGrammar ${where} exceeds the string-size limit.`);
  }
  return value;
}

interface CopyState {
  nodes: number;
}

/** Count one grammar node and enforce nesting bounds. */
function countNode(state: CopyState, depth: number) {
  state.nodes += 1;
  if (state.nodes > SYNTAX_GRAMMAR_LIMITS.nodes) {
    throw new Error("registerSyntaxGrammar exceeds the grammar-node limit.");
  }
  if (depth > SYNTAX_GRAMMAR_LIMITS.depth) {
    throw new Error("registerSyntaxGrammar exceeds the grammar-depth limit.");
  }
}

/** Copy captures without retaining extension-owned mutable objects. */
function copyCaptures(
  value: unknown,
  where: string,
  state: CopyState,
  depth: number,
): Readonly<Record<string, ExtensionSyntaxGrammarCapture>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`registerSyntaxGrammar requires ${where} to be an object.`);
  }
  const result: Record<string, ExtensionSyntaxGrammarCapture> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!/^\d+$/.test(key) || !isRecord(candidate)) {
      throw new Error(`registerSyntaxGrammar requires ${where} capture keys to be integers.`);
    }
    countNode(state, depth);
    assertOnlyKeys(candidate, CAPTURE_KEYS, `${where}.${key}`);
    const name = copyString(candidate.name, `${where}.${key}.name`, true);
    const contentName = copyString(candidate.contentName, `${where}.${key}.contentName`, true);
    const patterns = copyPatterns(
      candidate.patterns,
      `${where}.${key}.patterns`,
      state,
      depth + 1,
      true,
    );
    result[key] = Object.freeze({
      ...(name && { name }),
      ...(contentName && { contentName }),
      ...(patterns && { patterns }),
    });
  }
  return Object.freeze(result);
}

/** Copy one TextMate rule in Hunk's closed data-only subset. */
function copyRule(
  value: unknown,
  where: string,
  state: CopyState,
  depth: number,
): ExtensionSyntaxGrammarRule {
  if (!isRecord(value)) {
    throw new Error(`registerSyntaxGrammar requires ${where} to be an object.`);
  }
  countNode(state, depth);
  assertOnlyKeys(value, RULE_KEYS, where);

  const include = copyString(value.include, `${where}.include`, true);
  if (include && include !== "$self" && include !== "$base" && !include.startsWith("#")) {
    throw new Error(
      "registerSyntaxGrammar includes may reference only #local, $self, or $base rules.",
    );
  }
  const name = copyString(value.name, `${where}.name`, true);
  const contentName = copyString(value.contentName, `${where}.contentName`, true);
  const match = copyString(value.match, `${where}.match`, true);
  const begin = copyString(value.begin, `${where}.begin`, true);
  const end = copyString(value.end, `${where}.end`, true);
  const whilePattern = copyString(value.while, `${where}.while`, true);
  const patterns = copyPatterns(value.patterns, `${where}.patterns`, state, depth + 1, true);
  const captures = copyCaptures(value.captures, `${where}.captures`, state, depth + 1);
  const beginCaptures = copyCaptures(
    value.beginCaptures,
    `${where}.beginCaptures`,
    state,
    depth + 1,
  );
  const endCaptures = copyCaptures(value.endCaptures, `${where}.endCaptures`, state, depth + 1);
  const whileCaptures = copyCaptures(
    value.whileCaptures,
    `${where}.whileCaptures`,
    state,
    depth + 1,
  );
  const applyEndPatternLast = value.applyEndPatternLast;
  if (applyEndPatternLast !== undefined && applyEndPatternLast !== 0 && applyEndPatternLast !== 1) {
    throw new Error(`registerSyntaxGrammar requires ${where}.applyEndPatternLast to be 0 or 1.`);
  }
  if (!include && !match && !begin && !patterns) {
    throw new Error(
      `registerSyntaxGrammar requires ${where} to declare include, match, begin, or patterns.`,
    );
  }

  return Object.freeze({
    ...(include && { include }),
    ...(name && { name }),
    ...(contentName && { contentName }),
    ...(match && { match }),
    ...(begin && { begin }),
    ...(end && { end }),
    ...(whilePattern && { while: whilePattern }),
    ...(captures && { captures }),
    ...(beginCaptures && { beginCaptures }),
    ...(endCaptures && { endCaptures }),
    ...(whileCaptures && { whileCaptures }),
    ...(patterns && { patterns }),
    ...(applyEndPatternLast !== undefined && { applyEndPatternLast }),
  });
}

/** Copy a rule list, optionally accepting omission. */
function copyPatterns(
  value: unknown,
  where: string,
  state: CopyState,
  depth: number,
  optional = false,
): readonly ExtensionSyntaxGrammarRule[] | undefined {
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`registerSyntaxGrammar requires ${where} to be an array.`);
  }
  return Object.freeze(
    value.map((rule, index) => copyRule(rule, `${where}[${index}]`, state, depth)),
  );
}

/** Collect local includes so misspelled repository references fail during registration. */
function collectLocalIncludes(rule: ExtensionSyntaxGrammarRule, includes: Set<string>): void {
  if (rule.include?.startsWith("#")) includes.add(rule.include.slice(1));
  for (const nested of rule.patterns ?? []) collectLocalIncludes(nested, includes);
  for (const captures of [
    rule.captures,
    rule.beginCaptures,
    rule.endCaptures,
    rule.whileCaptures,
  ]) {
    for (const capture of Object.values(captures ?? {})) {
      for (const nested of capture.patterns ?? []) collectLocalIncludes(nested, includes);
    }
  }
}

/** Validate, deeply copy, and freeze one public syntax grammar. */
export function normalizeSyntaxGrammar(value: unknown): ExtensionSyntaxGrammar {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("registerSyntaxGrammar requires serializable grammar data.");
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > SYNTAX_GRAMMAR_LIMITS.bytes
  ) {
    throw new Error("registerSyntaxGrammar exceeds the serialized-size limit.");
  }
  if (!isRecord(value)) {
    throw new Error("registerSyntaxGrammar requires a grammar object.");
  }
  assertOnlyKeys(value, GRAMMAR_KEYS, "grammar");
  const id = copyString(value.id, "grammar.id")!;
  if (!ID_PATTERN.test(id) || id === "text" || id === "ansi") {
    throw new Error(
      "registerSyntaxGrammar grammar.id must be a lowercase language id and cannot be text or ansi.",
    );
  }
  const scopeName = copyString(value.scopeName, "grammar.scopeName")!;
  if (!SCOPE_PATTERN.test(scopeName)) {
    throw new Error(
      "registerSyntaxGrammar grammar.scopeName must start with source. or text. and use portable characters.",
    );
  }
  const state = { nodes: 1 };
  const patterns = copyPatterns(value.patterns, "grammar.patterns", state, 1)!;
  let repository: Record<string, ExtensionSyntaxGrammarRule> | undefined;
  if (value.repository !== undefined) {
    if (!isRecord(value.repository)) {
      throw new Error("registerSyntaxGrammar requires grammar.repository to be an object.");
    }
    repository = {};
    for (const [key, rule] of Object.entries(value.repository)) {
      if (!ID_PATTERN.test(key)) {
        throw new Error("registerSyntaxGrammar repository keys must be lowercase portable ids.");
      }
      repository[key] = copyRule(rule, `grammar.repository.${key}`, state, 1);
    }
    Object.freeze(repository);
  }
  const includes = new Set<string>();
  for (const rule of patterns) collectLocalIncludes(rule, includes);
  for (const rule of Object.values(repository ?? {})) collectLocalIncludes(rule, includes);
  for (const include of includes) {
    if (!repository?.[include]) {
      throw new Error(`registerSyntaxGrammar references missing local rule #${include}.`);
    }
  }
  return Object.freeze({ id, scopeName, patterns, ...(repository && { repository }) });
}
