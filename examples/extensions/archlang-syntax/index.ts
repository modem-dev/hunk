import type { HunkExtensionAPI } from "hunkdiff/extension";

/** Register a compact Archlang TextMate grammar through API v17. */
export default function archlangSyntax(hunk: HunkExtensionAPI) {
  hunk.registerSyntaxGrammar({
    id: "archlang",
    scopeName: "source.archlang",
    patterns: [
      { include: "#comments" },
      { include: "#strings" },
      { include: "#keywords" },
      { include: "#operators" },
      { include: "#numbers" },
      { include: "#variables" },
    ],
    repository: {
      comments: { match: "//.*$", name: "comment.line.double-slash.archlang" },
      strings: {
        begin: '"',
        end: '"',
        name: "string.quoted.double.archlang",
        patterns: [
          {
            match: '\\\\(?:[\\\\"nrt]|u[0-9a-fA-F]{4})',
            name: "constant.character.escape.archlang",
          },
        ],
      },
      keywords: {
        match:
          "\\b(?:arch|system|let|source|component|contract|type|record|tagged|operation|async|throws|bind|using|process|in_process|via|edges|rule|paths|components|excluding|cycles|forbidden|property|on|claim|verify|static|interface|probe|advisory|existing|version|compatibility|observed|constructed|provides|requires|roots|exclude|entrypoints)\\b",
        name: "keyword.control.archlang",
      },
      operators: { match: "-/>|->|[:=$]", name: "keyword.operator.archlang" },
      numbers: { match: "\\b\\d+(?:_\\d+)*\\b", name: "constant.numeric.archlang" },
      variables: { match: "\\$[a-z][a-z0-9_]*", name: "variable.other.archlang" },
    },
  });
  hunk.registerFileLanguage(".arch", "archlang");
}
