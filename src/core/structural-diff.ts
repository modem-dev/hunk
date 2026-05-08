import * as ts from "typescript";

/** Parse source code into a TypeScript AST. */
export function parseSource(code: string, fileName: string) {
  return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
}

/**
 * A simplified representation of a structural change.
 * This can be expanded to include specific AST node types.
 */
export interface StructuralChange {
  type: "addition" | "deletion" | "modification";
  nodeName?: string;
  startLine: number;
  endLine: number;
}

/** Compare two ASTs and find structural differences. */
export function compareStructural(
  before: string,
  after: string,
  fileName: string,
): StructuralChange[] {
  if (!/\.(tsx?|jsx?)$/i.test(fileName)) {
    return [];
  }

  const beforeSource = parseSource(before, fileName);
  const afterSource = parseSource(after, fileName);

  const changes: StructuralChange[] = [];

  // Basic implementation: Compare top-level nodes by their signatures/names
  const beforeNodes = new Map<string, ts.Node>();
  const afterNodes = new Map<string, ts.Node>();

  function collectTopLevel(source: ts.SourceFile, map: Map<string, ts.Node>) {
    source.forEachChild((node) => {
      let name: string | undefined;
      if (ts.isFunctionDeclaration(node) && node.name) {
        name = `function:${node.name.text}`;
      } else if (ts.isClassDeclaration(node) && node.name) {
        name = `class:${node.name.text}`;
      } else if (ts.isVariableStatement(node)) {
        // Handle const/let/var declarations
        node.declarationList.declarations.forEach((decl) => {
          if (ts.isIdentifier(decl.name)) {
            map.set(`variable:${decl.name.text}`, node);
          }
        });
      }

      if (name) {
        map.set(name, node);
      }
    });
  }

  collectTopLevel(beforeSource, beforeNodes);
  collectTopLevel(afterSource, afterNodes);

  // Find deletions and modifications
  for (const [name, beforeNode] of beforeNodes) {
    const afterNode = afterNodes.get(name);
    if (!afterNode) {
      const { line } = beforeSource.getLineAndCharacterOfPosition(beforeNode.getStart());
      changes.push({
        type: "deletion",
        nodeName: name,
        startLine: line + 1,
        endLine: beforeSource.getLineAndCharacterOfPosition(beforeNode.getEnd()).line + 1,
      });
    } else if (beforeNode.getText() !== afterNode.getText()) {
      // Basic text comparison of node content
      const { line } = afterSource.getLineAndCharacterOfPosition(afterNode.getStart());
      changes.push({
        type: "modification",
        nodeName: name,
        startLine: line + 1,
        endLine: afterSource.getLineAndCharacterOfPosition(afterNode.getEnd()).line + 1,
      });
    }
  }

  // Find additions
  for (const [name, afterNode] of afterNodes) {
    if (!beforeNodes.has(name)) {
      const { line } = afterSource.getLineAndCharacterOfPosition(afterNode.getStart());
      changes.push({
        type: "addition",
        nodeName: name,
        startLine: line + 1,
        endLine: afterSource.getLineAndCharacterOfPosition(afterNode.getEnd()).line + 1,
      });
    }
  }

  return changes;
}
