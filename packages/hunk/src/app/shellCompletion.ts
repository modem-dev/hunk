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
  readonly takesValue: boolean;
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

/** Create a command node with the help flags supported by every built-in. */
function createNode(): CompletionNode {
  return {
    flags: toFlags({ flag: "-h, --help", description: "show help" }),
    children: new Map(),
  };
}

/** Preserve argument arity for every short and long spelling of an option. */
function toFlags(option: CompletionOption): CompletionFlag[] {
  return option.flag.split(", ").map((names) => ({
    takesValue: /[<[]/.test(option.flag),
    name: names.split(" ")[0]!,
    description: option.description,
    values: option.values,
  }));
}

/** Build commands and options from metadata, including supported leading host flags. */
function buildCompletionTree(reference: CompletionReference) {
  const root = createNode();
  // These review options also work before the command, unlike command-local review options.
  const leadingNames = new Set([
    "--fast",
    "--experimental",
    "--extension",
    "--no-extensions",
    "--disable-extension",
    "--enable-extension",
  ]);
  root.flags.push(
    ...toFlags({ flag: "-v, --version", description: "show version" }),
    ...reference.commonReviewOptions.flatMap(toFlags).filter((flag) => leadingNames.has(flag.name)),
  );

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
    node.flags = [
      ...createNode().flags,
      ...options.filter((option) => !option.hidden).flatMap(toFlags),
    ];
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

/** Flatten command nodes into ordered shell case entries. */
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

/** Quote one literal for Bash and Zsh. */
function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Format a Zsh completion item with its optional description. */
function describeItem(name: string, summary?: string) {
  return shellQuote(summary ? `${name}:${summary}` : name);
}

/** Emit value completion branches for enumerated options. */
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

/** Emit nonempty branches for command-specific completion data. */
function nodeCases(
  entries: readonly CompletionEntry[],
  items: (entry: CompletionEntry) => string | undefined,
) {
  return entries.flatMap((entry) => {
    const body = items(entry);
    return body ? [`    ${shellQuote(entry.node)}) ${body} ;;`] : [];
  });
}

/** Scan command words without interpreting option arguments or pathspecs as commands. */
function renderWordScan(entries: readonly CompletionEntry[], shell: CompletionShell) {
  const start = shell === "bash" ? 1 : 2;
  const end = shell === "bash" ? "cword" : "CURRENT";
  const word = shell === "bash" ? '"${words[i]}"' : '"$words[i]"';
  const knownNodes = entries.slice(1).map((entry) => shellQuote(entry.node));
  const leadingFlags = entries[0]!.flags.flatMap((flag) => [
    shellQuote(flag.name),
    ...(flag.takesValue ? [`${shellQuote(`${flag.name}=`)}*`] : []),
  ]);
  const argumentCases = entries.flatMap((entry) =>
    entry.flags
      .filter((flag) => flag.takesValue)
      .map(
        (flag) =>
          `      ${shellQuote(`${entry.node} ${flag.name}`)}) [[ $word != *=* ]] && valueFlag="$word"; continue ;;`,
      ),
  );

  return [
    `  for ((i = ${start}; i < ${end}; i++)); do`,
    `    word=${word}`,
    "    if [[ -n $valueFlag ]]; then",
    '      valueFlag=""',
    "      continue",
    "    fi",
    "    if [[ $word == -- ]]; then",
    '      if [[ $node == " session reload" ]]; then',
    '        node=""; fast=0; argStart=$((i + 1))',
    "        continue",
    "      fi",
    "      positional=1",
    "      break",
    "    fi",
    "    if [[ -z $node && $word == --fast ]]; then",
    "      fast=1",
    "      continue",
    "    fi",
    '    case "$node $word" in',
    `      ${knownNodes.join("|")}) node="$node $word"; argStart=$((i + 1)); continue ;;`,
    "    esac",
    "    if [[ -z $node ]] && (( fast )); then",
    '      case "$word" in',
    `        ${leadingFlags.join("|")}) ;;`,
    '        *) node=" diff" ;;',
    "      esac",
    "    fi",
    '    case "$node ${word%%=*}" in',
    ...argumentCases,
    "    esac",
    "  done",
    "  if [[ -z $node ]] && (( fast )) && [[ -z $cur || $cur == -* ]]; then",
    '    node=" diff"',
    "  fi",
  ];
}

/** Normalize Bash word-break fragments without changing the shell's global COMP_WORDBREAKS. */
function renderBashWords() {
  return [
    "_hunk_words() {",
    "  if declare -F _get_comp_words_by_ref >/dev/null; then",
    "    _get_comp_words_by_ref -n =: cur words cword",
    "    return",
    "  fi",
    // Standalone loading must also work without bash-completion, including Bash 3.2.
    // Match fragments to their source positions so separators join only within one argument.
    // Bash before 4.3 reports byte offsets; newer versions report locale-aware character offsets.
    "  if (( BASH_VERSINFO[0] < 4 || BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 3 )); then",
    "    local LC_ALL=C",
    "  fi",
    '  local remaining="$COMP_LINE" prefix token previous="" offset=0 cursor="$COMP_POINT" j index',
    "  words=()",
    "  for ((j = 0; j <= COMP_CWORD; j++)); do",
    '    token="${COMP_WORDS[j]}"',
    "    if [[ -z $token ]]; then",
    '      prefix="${remaining:0:cursor - offset}"',
    "    else",
    '      prefix="${remaining%%"$token"*}"',
    "    fi",
    "    offset=$((offset + ${#prefix}))",
    '    remaining="${remaining:${#prefix} + ${#token}}"',
    "    if (( j == COMP_CWORD )); then",
    '      token="${token:0:cursor - offset}"',
    "    fi",
    "    if (( j > 0 )) && [[ -z $prefix && ( -n $token && -z ${token//[=:]/} || -n $previous && -z ${previous//[=:]/} ) ]]; then",
    "      index=$((${#words[@]} - 1))",
    '      words[index]="${words[index]}$token"',
    "    else",
    '      words[${#words[@]}]="$token"',
    "    fi",
    '    previous="${COMP_WORDS[j]}"',
    "    offset=$((offset + ${#COMP_WORDS[j]}))",
    "  done",
    "  cword=$((${#words[@]} - 1))",
    '  cur="${words[cword]}"',
    "}",
    "",
  ];
}

/** Render Bash completion with default filename fallback. */
function renderBash(entries: readonly CompletionEntry[]) {
  const flagWords = (entry: CompletionEntry) =>
    entry.flags.length > 0
      ? `flags="${entry.flags.map((flag) => flag.name).join(" ")}"`
      : undefined;
  const subcommandWords = (entry: CompletionEntry) =>
    entry.subcommands.length > 0
      ? `subcommands="${entry.subcommands.map((child) => child.name).join(" ")}"`
      : undefined;

  return [
    ...renderBashWords(),
    "_hunk() {",
    '  local cur node="" word subcommands="" flags="" valueFlag="" positional=0 fast=0 argStart=1 cword i',
    "  local -a words",
    "  COMPREPLY=()",
    "  _hunk_words",
    ...renderWordScan(entries, "bash"),
    "  (( positional )) && return",
    '  case "$node $valueFlag" in',
    ...valueCases(
      entries,
      (values) => `COMPREPLY=($(compgen -W "${values.join(" ")}" -- "$cur")); return`,
    ),
    "  esac",
    "  [[ -n $valueFlag ]] && return",
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

/** Escape metadata embedded in Zsh's native argument-specification syntax. */
function escapeZshArgument(value: string) {
  return value.replace(/[\\[\]:]/g, "\\$&");
}

/** Describe an option's arity and value action for native Zsh completion. */
function zshArgument(flag: CompletionFlag) {
  const name = flag.takesValue
    ? `${flag.name}${flag.name.startsWith("--") ? "=" : "+"}`
    : flag.name;
  const description = escapeZshArgument(flag.description);
  const action = flag.values ? `(${flag.values.map(escapeZshArgument).join(" ")})` : "_files";
  const value = flag.takesValue ? `:value:${action}` : "";
  return shellQuote(`*${name}[${description}]${value}`);
}

/** Render Zsh specifications while leaving option parsing and value completion to _arguments. */
function renderZsh(entries: readonly CompletionEntry[]) {
  return [
    "#compdef hunk",
    "compdef _hunk hunk",
    "",
    "_hunk() {",
    '  local cur="$words[CURRENT]" node="" word valueFlag="" positional=0 fast=0 argStart=2 i',
    '  local curcontext="$curcontext" state state_descr CURRENT="$CURRENT"',
    '  local -a words=("${words[@]}")',
    "  local -a args items line",
    "  local -A opt_args",
    ...renderWordScan(entries, "zsh"),
    "  if (( positional )); then",
    "    _files",
    "    return",
    "  fi",
    '  case "$node" in',
    ...nodeCases(entries, (entry) => {
      const positional =
        entry.subcommands.length > 0 ? "'1:command:->command' '*:path:->path'" : "'*:path:->path'";
      const items = entry.subcommands
        .map((child) => describeItem(child.name, child.summary))
        .join(" ");
      return `args=(${entry.flags.map(zshArgument).join(" ")} ${positional}); items=(${items})`;
    }),
    "  esac",
    // Drop host/namespace tokens, not option values, and preserve Zsh's quoted argument boundaries.
    '  words=(hunk "${(@)words[argStart,-1]}")',
    "  CURRENT=$((CURRENT - argStart + 2))",
    '  _arguments -S -s "${args[@]}" && return',
    "  if [[ $cur != -* ]]; then",
    '    case "$state" in',
    "      command) _describe -t commands command items ;;",
    "      path) _files ;;",
    "    esac",
    "  fi",
    "}",
    "",
    'if [ "$funcstack[1]" = "_hunk" ]; then',
    "  _hunk",
    "fi",
    "",
  ].join("\n");
}

/** Generate a completion script for one supported shell from CLI metadata. */
export function renderShellCompletion(shell: CompletionShell, reference: CompletionReference) {
  const entries = collectEntries(buildCompletionTree(reference), "");
  return shell === "bash" ? renderBash(entries) : renderZsh(entries);
}
