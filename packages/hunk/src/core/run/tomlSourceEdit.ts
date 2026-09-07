/**
 * Rewrites one key of a TOML config source while leaving every other byte alone.
 *
 * Hunk persists a handful of view preferences into a file the user also edits by hand, so this
 * writer edits lines instead of re-serializing: comments, ordering, indentation, and unrelated
 * tables survive a save. A line scanner tracks multiline strings and bracketed values so a table
 * header or `key = value` inside a string is never mistaken for structure, and headers and keys
 * compare by parsed path, so `["theme"]`, `[ theme ]`, and `[theme]` name the same table.
 *
 * The writer is deliberately narrow: it handles the string, boolean, and flat inline-table values
 * Hunk persists, and one key per call. It never touches the filesystem, and callers verify each
 * result by parsing it (see `config.ts`) rather than trusting the edit.
 */

/** A value Hunk knows how to write: a primitive, or a flat table whose `undefined` keys are removed. */
export type TomlWritableValue = string | boolean | Readonly<Record<string, string | undefined>>;

interface ValueScanState {
  /** Delimiter of the multiline string the scanner is inside, if any. */
  multiline: '"""' | "'''" | null;
  /** Unclosed `[`/`{` depth, so a multi-line array continues onto later lines. */
  depth: number;
}

export type ScannedTomlLine =
  | { kind: "blank" | "comment" | "continuation" | "unknown"; text: string }
  | {
      kind: "header";
      text: string;
      path: readonly string[];
      arrayOfTables: boolean;
      comment: string;
    }
  | {
      kind: "assignment";
      text: string;
      /** Key path relative to the enclosing table, so `theme.dark = …` is `["theme", "dark"]`. */
      path: readonly string[];
      comment: string;
      indent: string;
    };

const BARE_KEY_CHARS = /[A-Za-z0-9_-]/;

/** Parse a bare, quoted, or dotted key path starting at `start`; returns null when none is there. */
function parseKeyPath(text: string, start: number): { path: string[]; end: number } | null {
  const path: string[] = [];
  let index = start;
  for (;;) {
    while (text[index] === " " || text[index] === "\t") index += 1;
    const char = text[index];
    if (char === '"' || char === "'") {
      const close = text.indexOf(char, index + 1);
      if (close < 0) return null;
      path.push(text.slice(index + 1, close));
      index = close + 1;
    } else {
      let end = index;
      while (end < text.length && BARE_KEY_CHARS.test(text[end] ?? "")) end += 1;
      if (end === index) return null;
      path.push(text.slice(index, end));
      index = end;
    }
    while (text[index] === " " || text[index] === "\t") index += 1;
    if (text[index] !== ".") break;
    index += 1;
  }
  return { path, end: index };
}

/** Walk a value from `start`, tracking strings and brackets, and report the trailing comment. */
function scanValue(
  text: string,
  start: number,
  state: ValueScanState,
): { comment: string; state: ValueScanState } {
  let { multiline, depth } = state;
  let index = start;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (multiline) {
      if (multiline === '"""' && char === "\\") {
        index += 2;
        continue;
      }
      if (text.startsWith(multiline, index)) {
        // TOML lets a multiline string end in up to two extra quotes that belong to its content.
        let close = index + 3;
        while (close - index < 5 && text[close] === multiline[0]) close += 1;
        index = close;
        multiline = null;
        continue;
      }
      index += 1;
      continue;
    }
    if (text.startsWith('"""', index) || text.startsWith("'''", index)) {
      multiline = text.slice(index, index + 3) as '"""' | "'''";
      index += 3;
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === "'") {
      const close = text.indexOf("'", index + 1);
      index = close < 0 ? text.length : close + 1;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth = Math.max(0, depth - 1);
    else if (char === "#")
      return { comment: text.slice(index).trimEnd(), state: { multiline, depth } };
    index += 1;
  }
  return { comment: "", state: { multiline, depth } };
}

/** Classify every line of a TOML source without interpreting values. */
export function scanTomlSource(source: string): ScannedTomlLine[] {
  const lines = source.length > 0 ? source.split("\n") : [];
  let state: ValueScanState = { multiline: null, depth: 0 };
  return lines.map((text): ScannedTomlLine => {
    if (state.multiline || state.depth > 0) {
      state = scanValue(text, 0, state).state;
      return { kind: "continuation", text };
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) return { kind: "blank", text };
    if (trimmed.startsWith("#")) return { kind: "comment", text };
    if (trimmed.startsWith("[")) {
      const arrayOfTables = trimmed.startsWith("[[");
      const open = text.indexOf("[") + (arrayOfTables ? 2 : 1);
      const key = parseKeyPath(text, open);
      if (!key) return { kind: "unknown", text };
      const closer = arrayOfTables ? "]]" : "]";
      if (!text.startsWith(closer, key.end)) return { kind: "unknown", text };
      const rest = text.slice(key.end + closer.length).trim();
      if (rest.length > 0 && !rest.startsWith("#")) return { kind: "unknown", text };
      return { kind: "header", text, path: key.path, arrayOfTables, comment: rest };
    }
    const key = parseKeyPath(text, 0);
    if (!key || text[key.end] !== "=") return { kind: "unknown", text };
    const scanned = scanValue(text, key.end + 1, { multiline: null, depth: 0 });
    state = scanned.state;
    return {
      kind: "assignment",
      text,
      path: key.path,
      comment: scanned.comment,
      indent: text.match(/^\s*/)?.[0] ?? "",
    };
  });
}

function pathsEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function pathStartsWith(path: readonly string[], prefix: readonly string[]) {
  return path.length >= prefix.length && prefix.every((segment, index) => segment === path[index]);
}

/** Serialize one writable value as TOML assignment text. */
export function serializeTomlValue(value: TomlWritableValue) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, entry]) => `${key} = ${JSON.stringify(entry)}`);
  return `{ ${entries.join(", ")} }`;
}

/** The lines one table owns: `start` is the first body line, `end` is exclusive. */
interface TableBlock {
  headerIndex: number;
  start: number;
  end: number;
}

/** Locate the body of `[path]`, or the root table when `path` is empty. */
function findTableBlock(
  lines: readonly ScannedTomlLine[],
  path: readonly string[],
): TableBlock | null {
  const nextHeaderAfter = (index: number) => {
    const offset = lines.slice(index).findIndex((line) => line.kind === "header");
    return offset < 0 ? lines.length : index + offset;
  };
  if (path.length === 0) {
    return { headerIndex: -1, start: 0, end: nextHeaderAfter(0) };
  }
  const headerIndex = lines.findIndex(
    (line) => line.kind === "header" && !line.arrayOfTables && pathsEqual(line.path, path),
  );
  if (headerIndex < 0) return null;
  return { headerIndex, start: headerIndex + 1, end: nextHeaderAfter(headerIndex + 1) };
}

/** Step `end` back over the blank and comment lines that introduce whatever follows the block. */
function trimBlockEnd(lines: readonly ScannedTomlLine[], start: number, end: number) {
  while (end > start) {
    const kind = lines[end - 1]?.kind;
    if (kind !== "blank" && kind !== "comment") break;
    end -= 1;
  }
  return end;
}

/** Step `start` back over the contiguous comment lines that document a header. */
function leadingCommentStart(lines: readonly ScannedTomlLine[], headerIndex: number) {
  let start = headerIndex;
  while (start > 0 && lines[start - 1]?.kind === "comment") start -= 1;
  return start;
}

/** Report whether the table at `scope` defines `key`, as an assignment or a sub-table. */
export function tomlTableDefinesKey(
  source: string,
  scope: readonly string[],
  key: string,
): boolean {
  const lines = scanTomlSource(source);
  const block = findTableBlock(lines, scope);
  const target = [...scope, key];
  if (
    block &&
    lines
      .slice(block.start, block.end)
      .some((line) => line.kind === "assignment" && line.path[0] === key)
  ) {
    return true;
  }
  return lines.some((line) => line.kind === "header" && pathStartsWith(line.path, target));
}

/** Replace a whole-line run with `replacement`, leaving at most one blank line between neighbours. */
function collapseBlankSeam(lines: string[], index: number) {
  let start = index;
  while (start > 0 && (lines[start - 1] ?? "").trim().length === 0) start -= 1;
  let end = index;
  while (end < lines.length && (lines[end] ?? "").trim().length === 0) end += 1;
  const separators = start > 0 && end < lines.length ? [""] : [];
  lines.splice(start, end - start, ...separators);
}

function joinLines(lines: readonly string[]) {
  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

/** Rewrite one assignment line in place, keeping its indent and trailing comment. */
function rewriteAssignment(line: ScannedTomlLine & { kind: "assignment" }, assignment: string) {
  return `${line.indent}${assignment}${line.comment ? ` ${line.comment}` : ""}`;
}

/** Insert lines into the table at `scope`, after its last definition. */
function insertIntoTable(
  lines: string[],
  scope: readonly string[],
  newLines: readonly string[],
): boolean {
  const scanned = scanTomlSource(joinLines(lines));
  const block = findTableBlock(scanned, scope);
  if (!block) return false;
  if (block.headerIndex < 0) {
    // Root keys sit above the first header, but leave that header's comment block attached to it
    // and keep (or add) one blank line between the keys and the header.
    let insertAt = block.end;
    if (insertAt < scanned.length) {
      insertAt = leadingCommentStart(scanned, insertAt);
    }
    const hasSpacer = insertAt > 0 && scanned[insertAt - 1]?.kind === "blank";
    if (hasSpacer) insertAt -= 1;
    // A hoisted comment block reads as its own paragraph, so keep a blank line above it.
    const leadIn =
      insertAt > 0 && newLines[0]?.trim().startsWith("#") && scanned[insertAt - 1]?.kind !== "blank"
        ? [""]
        : [];
    lines.splice(
      insertAt,
      0,
      ...leadIn,
      ...newLines,
      ...(hasSpacer || insertAt === scanned.length ? [] : [""]),
    );
    return true;
  }
  const insertAt = trimBlockEnd(scanned, block.start, block.end);
  const sibling = scanned
    .slice(block.start, insertAt)
    .reverse()
    .find((line) => line.kind === "assignment");
  const indent = sibling?.kind === "assignment" ? sibling.indent : "";
  lines.splice(insertAt, 0, ...newLines.map((line) => `${indent}${line}`));
  return true;
}

/**
 * Write `key = value` into the table at `scope`, replacing every existing definition of the key:
 * plain, quoted, or dotted assignments and `[scope.key]` sub-tables alike. Comments on a removed
 * sub-table move with the key so nothing the user wrote is lost. Returns null when the scope table
 * does not exist or the key is defined in a form this writer cannot rewrite.
 */
export function upsertTomlValue(
  source: string,
  scope: readonly string[],
  key: string,
  value: TomlWritableValue,
): string | null {
  const scanned = scanTomlSource(source);
  const block = findTableBlock(scanned, scope);
  if (!block) return null;
  const target = [...scope, key];
  if (
    scanned.some(
      (line) => line.kind === "header" && line.arrayOfTables && pathStartsWith(line.path, target),
    )
  ) {
    return null;
  }
  const lines = scanned.map((line) => line.text);
  const assignment = `${key} = ${serializeTomlValue(value)}`;

  const direct: number[] = [];
  const dotted: number[] = [];
  for (let index = block.start; index < block.end; index += 1) {
    const line = scanned[index];
    if (line?.kind !== "assignment" || line.path[0] !== key) continue;
    (line.path.length === 1 ? direct : dotted).push(index);
  }
  const subTableHeaders = scanned
    .map((line, index) =>
      line.kind === "header" && pathStartsWith(line.path, target) ? index : -1,
    )
    .filter((index) => index >= 0);
  const exactSubTable = subTableHeaders.find((index) => {
    const line = scanned[index];
    return line?.kind === "header" && pathsEqual(line.path, target);
  });

  // A flat table value keeps an existing `[scope.key]` sub-table and edits its keys in place.
  if (typeof value === "object" && exactSubTable !== undefined && subTableHeaders.length === 1) {
    const table = findTableBlock(scanned, target);
    if (!table) return null;
    const removals = [...direct, ...dotted];
    let end = trimBlockEnd(scanned, table.start, table.end);
    const inserted: string[] = [];
    for (const [entryKey, entry] of Object.entries(value)) {
      const existing = scanned.findIndex(
        (line, index) =>
          index >= table.start &&
          index < end &&
          line.kind === "assignment" &&
          pathsEqual(line.path, [entryKey]),
      );
      const existingLine = scanned[existing];
      if (existingLine?.kind === "assignment") {
        if (entry === undefined) removals.push(existing);
        else
          lines[existing] = rewriteAssignment(
            existingLine,
            `${entryKey} = ${JSON.stringify(entry)}`,
          );
        continue;
      }
      if (entry !== undefined) inserted.push(`${entryKey} = ${JSON.stringify(entry)}`);
    }
    const sibling = scanned
      .slice(table.start, end)
      .reverse()
      .find((line) => line.kind === "assignment");
    const indent = sibling?.kind === "assignment" ? sibling.indent : "";
    lines.splice(end, 0, ...inserted.map((line) => `${indent}${line}`));
    for (const index of removals.sort((left, right) => right - left)) {
      lines.splice(index, 1);
      if (index < end) end -= 1;
    }
    return joinLines(lines);
  }

  // Otherwise one assignment line carries the value. Reuse the first existing assignment so its
  // position and trailing comment survive, and fold every other definition away.
  const hoisted: string[] = [];
  let headerComment = "";
  const removalRanges: Array<{ start: number; end: number }> = [];
  for (const headerIndex of subTableHeaders) {
    const header = scanned[headerIndex];
    if (header?.kind !== "header") continue;
    const start = leadingCommentStart(scanned, headerIndex);
    const nextHeader = scanned.findIndex(
      (line, index) => index > headerIndex && line.kind === "header",
    );
    const end = trimBlockEnd(
      scanned,
      headerIndex + 1,
      nextHeader < 0 ? scanned.length : nextHeader,
    );
    for (let index = start; index < headerIndex; index += 1) hoisted.push(lines[index] ?? "");
    if (header.comment) headerComment ||= header.comment;
    for (let index = headerIndex + 1; index < end; index += 1) {
      const line = scanned[index];
      if (line?.kind === "comment") hoisted.push(line.text);
      else if (line?.kind === "assignment" && line.comment)
        hoisted.push(`${line.indent}${line.comment}`);
    }
    removalRanges.push({ start, end });
  }

  const [keep, ...duplicates] = [...direct, ...dotted].sort((left, right) => left - right);
  const singleRemovals = duplicates.map((index) => ({ start: index, end: index + 1 }));
  const withComment = headerComment ? `${assignment} ${headerComment}` : assignment;

  if (keep !== undefined) {
    const line = scanned[keep];
    if (line?.kind !== "assignment") return null;
    lines[keep] = rewriteAssignment(
      line,
      line.comment || !headerComment ? assignment : withComment,
    );
    const ranges = [...removalRanges, ...singleRemovals].sort(
      (left, right) => right.start - left.start,
    );
    let insertAt = keep;
    for (const range of ranges) {
      lines.splice(range.start, range.end - range.start);
      if (range.start < insertAt) insertAt -= range.end - range.start;
      if (range.end - range.start > 1) collapseBlankSeam(lines, range.start);
    }
    // Hoisted comments explain the value that now lives on the rewritten line.
    lines.splice(insertAt, 0, ...hoisted.map((comment) => `${line.indent}${comment.trim()}`));
    return joinLines(lines);
  }

  for (const range of [...removalRanges, ...singleRemovals].sort(
    (left, right) => right.start - left.start,
  )) {
    lines.splice(range.start, range.end - range.start);
    collapseBlankSeam(lines, range.start);
  }
  if (!insertIntoTable(lines, scope, [...hoisted, withComment])) return null;
  return joinLines(lines);
}
