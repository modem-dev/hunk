import { SESSION_AGENT_COMMAND_LIST } from "../session/agent/surface";

export const COMPLETION_SHELLS = ["bash", "zsh"] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

interface CompletionOption {
  readonly flag: string;
  readonly description: string;
  readonly hidden?: boolean;
  readonly values?: readonly string[];
}

interface CompletionReferenceCommand {
  readonly path: string;
  readonly summary: string;
  readonly aliases?: readonly string[];
  readonly options?: readonly CompletionOption[];
  readonly commonReviewOptions?: boolean;
  readonly watch?: boolean;
}

export interface CompletionReference {
  readonly commands: Readonly<Record<string, CompletionReferenceCommand>>;
  readonly commonReviewOptions: readonly CompletionOption[];
  readonly watchOption: CompletionOption;
}

interface CompletionFlag {
  readonly name: string;
  readonly description: string;
  readonly values?: readonly string[];
}

interface CompletionNode {
  summary?: string;
  flags: CompletionFlag[];
  children: Map<string, CompletionNode>;
}

interface CompletionEntry {
  readonly node: string;
  readonly flags: readonly CompletionFlag[];
  readonly subcommands: readonly { name: string; summary?: string }[];
}

function createNode(): CompletionNode {
  return { flags: [], children: new Map() };
}

function toFlags(option: CompletionOption): CompletionFlag[] {
  return option.flag.split(", ").map((names) => ({
    name: names.split(" ")[0]!,
    description: option.description,
    values: option.values,
  }));
}

function buildCompletionTree(reference: CompletionReference) {
  const root = createNode();

  const add = (path: string, summary: string, options: readonly CompletionOption[]) => {
    let node = root;
    for (const word of path.split(" ")) {
      let child = node.children.get(word);
      if (!child) {
        child = createNode();
        node.children.set(word, child);
      }
      node = child;
    }
    node.summary = summary;
    node.flags = options.filter((option) => !option.hidden).flatMap(toFlags);
  };

  for (const spec of Object.values(reference.commands)) {
    const options = [
      ...(spec.commonReviewOptions ? reference.commonReviewOptions : []),
      ...(spec.watch ? [reference.watchOption] : []),
      ...(spec.options ?? []),
    ];
    const aliasPaths = (spec.aliases ?? []).map((alias) => alias.replace(/^hunk /, ""));
    for (const path of [spec.path, ...aliasPaths]) {
      add(path, spec.summary, options);
    }
  }

  for (const spec of SESSION_AGENT_COMMAND_LIST) {
    add(spec.name, spec.summary, spec.options);
  }

  for (const shell of COMPLETION_SHELLS) {
    add(`completion ${shell}`, `print the ${shell} completion script`, []);
  }

  return root;
}

function collectEntries(node: CompletionNode, path: string): CompletionEntry[] {
  const children = [...node.children.entries()];
  return [
    {
      node: path,
      flags: node.flags,
      subcommands: children.map(([name, child]) => ({ name, summary: child.summary })),
    },
    ...children.flatMap(([name, child]) => collectEntries(child, `${path} ${name}`)),
  ];
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function describeItem(name: string, summary?: string) {
  return shellQuote(summary ? `${name}:${summary}` : name);
}

function valueCases(entries: readonly CompletionEntry[], action: (values: string[]) => string) {
  return entries.flatMap((entry) =>
    entry.flags
      .filter((flag) => flag.values)
      .map(
        (flag) =>
          `    ${shellQuote(`${entry.node} ${flag.name}`)}) ${action([...flag.values!])} ;;`,
      ),
  );
}

function nodeCases(
  entries: readonly CompletionEntry[],
  items: (entry: CompletionEntry) => string | undefined,
) {
  return entries.flatMap((entry) => {
    const body = items(entry);
    return body ? [`    ${shellQuote(entry.node)}) ${body} ;;`] : [];
  });
}

function renderBash(entries: readonly CompletionEntry[]) {
  const knownNodes = entries.slice(1).map((entry) => shellQuote(entry.node));
  const flagWords = (entry: CompletionEntry) =>
    entry.flags.length > 0
      ? `flags="${entry.flags.map((flag) => flag.name).join(" ")}"`
      : undefined;
  const subcommandWords = (entry: CompletionEntry) =>
    entry.subcommands.length > 0
      ? `subcommands="${entry.subcommands.map((child) => child.name).join(" ")}"`
      : undefined;

  return [
    "_hunk() {",
    '  local cur="${COMP_WORDS[COMP_CWORD]}" prev="${COMP_WORDS[COMP_CWORD-1]}" node="" word subcommands="" flags="" i',
    "  COMPREPLY=()",
    "  for ((i = 1; i < COMP_CWORD; i++)); do",
    '    word="${COMP_WORDS[i]}"',
    '    case "$node $word" in',
    `      ${knownNodes.join("|")}) node="$node $word" ;;`,
    "    esac",
    "  done",
    '  case "$node $prev" in',
    ...valueCases(
      entries,
      (values) => `COMPREPLY=($(compgen -W "${values.join(" ")}" -- "$cur")); return`,
    ),
    "  esac",
    '  case "$node" in',
    ...nodeCases(entries, (entry) =>
      [flagWords(entry), subcommandWords(entry)].filter(Boolean).join("; "),
    ),
    "  esac",
    "  if [[ $cur == -* ]]; then",
    '    COMPREPLY=($(compgen -W "$flags" -- "$cur"))',
    "  else",
    '    COMPREPLY=($(compgen -W "$subcommands" -- "$cur"))',
    "  fi",
    "}",
    "",
    "complete -o default -F _hunk hunk",
    "",
  ].join("\n");
}

function renderZsh(entries: readonly CompletionEntry[]) {
  const knownNodes = entries.slice(1).map((entry) => shellQuote(entry.node));
  const flagItems = (entry: CompletionEntry) =>
    entry.flags.length > 0
      ? `items=(${entry.flags.map((flag) => describeItem(flag.name, flag.description)).join(" ")})`
      : undefined;
  const subcommandItems = (entry: CompletionEntry) =>
    entry.subcommands.length > 0
      ? `items=(${entry.subcommands.map((child) => describeItem(child.name, child.summary)).join(" ")})`
      : undefined;

  return [
    "#compdef hunk",
    "compdef _hunk hunk",
    "",
    "_hunk() {",
    '  local cur="$words[CURRENT]" prev="$words[CURRENT-1]" node="" word i',
    "  local -a items",
    "  for ((i = 2; i < CURRENT; i++)); do",
    '    word="$words[i]"',
    '    case "$node $word" in',
    `      ${knownNodes.join("|")}) node="$node $word" ;;`,
    "    esac",
    "  done",
    '  case "$node $prev" in',
    ...valueCases(
      entries,
      (values) => `items=(${values.join(" ")}); _describe -t values value items; return`,
    ),
    "  esac",
    "  items=()",
    "  if [[ $cur == -* ]]; then",
    '    case "$node" in',
    ...nodeCases(entries, flagItems).map((line) => `  ${line}`),
    "    esac",
    "    _describe -t options option items",
    "    return",
    "  fi",
    '  case "$node" in',
    ...nodeCases(entries, subcommandItems),
    "  esac",
    "  if (( $#items )); then",
    "    _describe -t commands command items",
    "  else",
    "    _files",
    "  fi",
    "}",
    "",
    'if [ "$funcstack[1]" = "_hunk" ]; then',
    "  _hunk",
    "fi",
    "",
  ].join("\n");
}

export function renderShellCompletion(shell: CompletionShell, reference: CompletionReference) {
  const entries = collectEntries(buildCompletionTree(reference), "");
  return shell === "bash" ? renderBash(entries) : renderZsh(entries);
}
