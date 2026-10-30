import { parse, type Node } from "acorn";
import { analyze } from "eslint-scope";

export type ModuleSpecifierKind = "import" | "dynamic-import" | "require";

/** Rewrite only literal module references, leaving data strings and member calls intact. */
export function rewriteModuleSpecifiers(
  code: string,
  rewrite: (specifier: string, kind: ModuleSpecifierKind) => string | undefined,
) {
  const replacements: { start: number; end: number; value: string }[] = [];
  const program = parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
    ranges: true,
  });
  const scopes = analyze(program as Parameters<typeof analyze>[0], {
    ecmaVersion: 2025,
    sourceType: "module",
  });
  const requireReferences = scopes.globalScope.through.filter(
    (reference) => reference.identifier.name === "require",
  );
  // A lexical binding is not the runtime loader. A write to the unbound name also
  // makes loader ownership uncertain, so conservatively leave those calls intact.
  const runtimeRequires = new Set(
    requireReferences.some((reference) => reference.isWrite())
      ? []
      : requireReferences.map((reference) => reference.identifier.range?.[0]),
  );

  /** Collect literal imports, re-exports, and unshadowed require calls from the syntax tree. */
  function visit(node: Node) {
    const fields = node as Node & Record<string, unknown>;
    let source: unknown;
    let kind: ModuleSpecifierKind = "import";
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ImportExpression"
    ) {
      source = fields.source;
      if (node.type === "ImportExpression") kind = "dynamic-import";
    } else if (node.type === "CallExpression") {
      const callee = fields.callee as Node & { name?: string };
      const args = fields.arguments as unknown[];
      if (
        callee.type === "Identifier" &&
        callee.name === "require" &&
        runtimeRequires.has(callee.start) &&
        args.length === 1
      ) {
        source = args[0];
        kind = "require";
      }
    }

    const literal = source as (Node & { value?: unknown }) | undefined;
    if (literal?.type === "Literal" && typeof literal.value === "string") {
      const value = rewrite(literal.value, kind);
      if (value !== undefined && value !== literal.value) {
        replacements.push({ start: literal.start, end: literal.end, value: JSON.stringify(value) });
      }
    }

    for (const value of Object.values(fields)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isNode(child)) visit(child);
        }
      } else if (isNode(value)) {
        visit(value);
      }
    }
  }

  visit(program);

  // Apply edits backwards so offsets continue to refer to the original source.
  for (const { start, end, value } of replacements.sort((a, b) => b.start - a.start)) {
    code = code.slice(0, start) + value + code.slice(end);
  }
  return code;
}

/** Recognize syntax-tree children without depending on parser-specific visitor tables. */
function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "type" in value;
}
