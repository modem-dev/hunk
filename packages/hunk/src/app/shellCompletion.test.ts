import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURSOR_LINE_VALUES, LAYOUT_MODE_VALUES } from "../core/run/commandInputs";
import { UPDATE_METHOD_VALUES } from "../core/install/selfUpdate";
import { SESSION_AGENT_COMMAND_LIST } from "../session/agent/surface";
import {
  CLI_REFERENCE_COMMANDS,
  COMMON_REVIEW_OPTIONS,
  WATCH_OPTION,
  type CliReferenceCommand,
} from "./cli";
import { COMPLETION_SHELLS, renderShellCompletion } from "./shellCompletion";

const reference = {
  commands: CLI_REFERENCE_COMMANDS,
  commonReviewOptions: COMMON_REVIEW_OPTIONS,
  watchOption: WATCH_OPTION,
};
const bashScript = renderShellCompletion("bash", reference);
const zshScript = renderShellCompletion("zsh", reference);

function flagNames(flag: string) {
  return flag.split(", ").map((names) => names.split(" ")[0]!);
}

function bashWords(node: string, kind: "flags" | "subcommands") {
  const pattern = node ? `' ${node}'` : "''";
  const line = bashScript.split("\n").find((entry) => entry.startsWith(`    ${pattern})`));
  const match = line?.match(new RegExp(`${kind}="([^"]*)"`));
  return match ? match[1]!.split(" ") : [];
}

const referenceCommands: CliReferenceCommand[] = Object.values(CLI_REFERENCE_COMMANDS);

const completableCommands = [
  ...referenceCommands.flatMap((spec) => {
    const options = [
      ...(spec.commonReviewOptions ? COMMON_REVIEW_OPTIONS : []),
      ...(spec.watch ? [WATCH_OPTION] : []),
      ...(spec.options ?? []),
    ];
    const aliases = (spec.aliases ?? []).map((alias) => alias.replace(/^hunk /, ""));
    return [spec.path, ...aliases].map((path) => ({ path, options }));
  }),
  ...SESSION_AGENT_COMMAND_LIST.map((spec) => ({ path: spec.name, options: spec.options })),
];

describe("shell completion scripts", () => {
  test("offer every command path, alias, and visible flag from the CLI metadata", () => {
    for (const { path, options } of completableCommands) {
      const words = path.split(" ");
      expect(bashWords(words.slice(0, -1).join(" "), "subcommands")).toContain(words.at(-1)!);

      const flags = bashWords(path, "flags");
      for (const option of options.filter((entry) => !(entry as { hidden?: boolean }).hidden)) {
        for (const name of flagNames(option.flag)) {
          expect(flags).toContain(name);
          expect(zshScript).toContain(
            `'*${name}${/[<[]/.test(option.flag) ? (name.startsWith("--") ? "=" : "+") : ""}[`,
          );
        }
      }
    }
  });

  test("offer top-level aliases and session subcommands", () => {
    const topLevel = bashWords("", "subcommands");
    expect(topLevel).toEqual(expect.arrayContaining(["ext", "mcp", "session", "daemon", "stash"]));
    expect(bashWords("session comment", "subcommands")).toContain("apply");
    expect(bashWords("completion", "subcommands")).toEqual([...COMPLETION_SHELLS]);
  });

  test("leave hidden flags out", () => {
    expect(bashWords("diff", "flags")).not.toContain("--vcs");
    expect(bashWords("diff", "flags")).not.toContain("--no-exclude-untracked");
    expect(bashWords("log", "flags")).toContain("--vcs");
    expect(zshScript).not.toContain("--no-exclude-untracked");
    expect(zshScript).not.toContain("'--vcs:select a VCS provider'");
  });

  test("offer the allowed values of enumerated flags", () => {
    for (const [flag, values] of [
      ["diff --mode", LAYOUT_MODE_VALUES],
      ["diff --cursor-line", CURSOR_LINE_VALUES],
      ["update --method", UPDATE_METHOD_VALUES],
    ] as const) {
      expect(bashScript).toContain(`' ${flag}') COMPREPLY=($(compgen -W "${values.join(" ")}"`);
      expect(zshScript).toContain(`:value:(${values.join(" ")})'`);
    }
  });

  test("register completion for bash and zsh", () => {
    expect(bashScript).toContain("complete -o default -F _hunk hunk");
    expect(zshScript.startsWith("#compdef hunk\n")).toBe(true);
    expect(zshScript).toContain("_arguments -S -s");
    expect(zshScript).toContain("_describe");
    expect(zshScript).toContain("_files");
  });
});

describe("shell completion scripts in real shells", () => {
  const bashExecutable = process.env.HUNK_TEST_BASH_EXECUTABLE ?? Bun.which("bash");
  const hasBash = process.platform !== "win32" && bashExecutable !== null;
  const hasZsh = process.platform !== "win32" && Bun.which("zsh") !== null;
  let directory = "";
  let bashPath = "";
  let zshPath = "";

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "hunk-completion-"));
    bashPath = join(directory, "hunk.bash");
    zshPath = join(directory, "_hunk");
    writeFileSync(bashPath, bashScript);
    writeFileSync(zshPath, zshScript);
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** Quote shell test inputs without interpreting paths or apostrophes. */
  function quoteShell(value: string) {
    return `'${value.replaceAll("'", "'\\''")}'`;
  }

  /** Invoke the generated Bash function with real source positions for word-break fragments. */
  function bashCompletionsForLine(line: string, ...words: string[]) {
    const quoted = words.map(quoteShell).join(" ");
    const result = Bun.spawnSync([
      bashExecutable!,
      "-c",
      `source ${quoteShell(bashPath)}; COMP_LINE=${quoteShell(line)}; COMP_POINT=\${#COMP_LINE}; if (( BASH_VERSINFO[0] < 4 || BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 3 )); then COMP_POINT=${Buffer.byteLength(line)}; fi; COMP_WORDS=(${quoted}); COMP_CWORD=${words.length - 1}; _hunk; printf '%s\\n' "\${COMPREPLY[@]}"`,
    ]);
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().split("\n").filter(Boolean);
  }

  /** Supply ordinary completion words without Bash's equals-sign fragmentation. */
  function bashCompletions(...words: string[]) {
    return bashCompletionsForLine(words.join(" "), ...words);
  }

  test.skipIf(!hasBash)("completes commands, subcommands, flags, and flag values in bash", () => {
    expect(bashCompletions("hunk", "se")).toEqual(["session"]);
    expect(bashCompletions("hunk", "session", "")).toEqual(
      expect.arrayContaining(["list", "comment", "highlight"]),
    );
    expect(bashCompletions("hunk", "diff", "--mo")).toEqual(["--mode"]);
    expect(bashCompletions("hunk", "diff", "--mode", "")).toEqual([...LAYOUT_MODE_VALUES]);
    expect(bashCompletions("hunk", "diff", "")).toEqual([]);
  });

  test.skipIf(!hasBash)("respects option arguments and pathspec separators in bash", () => {
    expect(bashCompletions("hunk", "--extension", "session", "diff", "--mo")).toEqual(["--mode"]);
    expect(bashCompletions("hunk", "--disable-extension", "session", "diff", "--mo")).toEqual([
      "--mode",
    ]);
    expect(bashCompletions("hunk", "--extension=session", "diff", "--mo")).toEqual(["--mode"]);
    expect(bashCompletions("hunk", "--extension", "se")).toEqual([]);
    expect(bashCompletions("hunk", "--extension", "--mode", "")).toContain("diff");
    expect(bashCompletions("hunk", "diff", "--", "--mo")).toEqual([]);
    expect(bashCompletions("hunk", "diff", "--", "--mode", "")).toEqual([]);
    expect(bashCompletions("hunk", "diff", "--mode", "split", "--cu")).toEqual(["--cursor-line"]);
    expect(bashCompletions("hunk", "log", "-n", "session", "--au")).toEqual(["--author"]);
  });

  test.skipIf(!hasBash)("offers help and supported leading flags in bash", () => {
    expect(bashCompletions("hunk", "--he")).toEqual(["--help"]);
    expect(bashCompletions("hunk", "--ver")).toEqual(["--version"]);
    expect(bashCompletions("hunk", "--ext")).toEqual(["--extension"]);
    expect(bashCompletions("hunk", "--fa")).toEqual(["--fast"]);
    expect(bashCompletions("hunk", "--mo")).toEqual([]);
    expect(bashCompletions("hunk", "diff", "--he")).toEqual(["--help"]);
    expect(bashCompletions("hunk", "session", "comment", "-h")).toEqual(["-h"]);
  });

  test.skipIf(!hasBash)(
    "reassembles adjacent equals fragments but preserves real argument spaces",
    () => {
      expect(
        bashCompletionsForLine(
          "hunk --extension=session diff --mo",
          "hunk",
          "--extension",
          "=",
          "session",
          "diff",
          "--mo",
        ),
      ).toEqual(["--mode"]);
      expect(
        bashCompletionsForLine(
          "hunk --disable-extension=session diff --mo",
          "hunk",
          "--disable-extension",
          "=",
          "session",
          "diff",
          "--mo",
        ),
      ).toEqual(["--mode"]);
      expect(
        bashCompletionsForLine(
          "hunk --extension= diff --mo",
          "hunk",
          "--extension",
          "=",
          "diff",
          "--mo",
        ),
      ).toEqual(["--mode"]);
      expect(bashCompletions("hunk", "--extension", "=", "session", "--ge")).toEqual([]);
      expect(
        bashCompletionsForLine("hunk --extension== ", "hunk", "--extension", "==", ""),
      ).toContain("diff");
      expect(
        bashCompletionsForLine(
          "hunk --extension=prefix:: ",
          "hunk",
          "--extension",
          "=",
          "prefix",
          "::",
          "",
        ),
      ).toContain("diff");
      expect(
        bashCompletionsForLine(
          "hunk --extension=prefix::session diff --mo",
          "hunk",
          "--extension",
          "=",
          "prefix",
          "::",
          "session",
          "diff",
          "--mo",
        ),
      ).toEqual(["--mode"]);
      expect(
        bashCompletionsForLine(
          "hunk --extension==session diff --mo",
          "hunk",
          "--extension",
          "==",
          "session",
          "diff",
          "--mo",
        ),
      ).toEqual(["--mode"]);
      expect(
        bashCompletionsForLine(
          "hunk --extension=préfix:session diff --mo",
          "hunk",
          "--extension",
          "=",
          "préfix",
          ":",
          "session",
          "diff",
          "--mo",
        ),
      ).toEqual(["--mode"]);
    },
  );

  test.skipIf(!hasBash)("enters nested reload and implicit diff contexts", () => {
    expect(bashCompletions("hunk", "session", "reload", "test", "--", "di")).toEqual([
      "diff",
      "difftool",
    ]);
    expect(bashCompletions("hunk", "session", "reload", "test", "--", "diff", "--mo")).toEqual([
      "--mode",
    ]);
    expect(
      bashCompletions("hunk", "session", "reload", "test", "--", "diff", "--mode", "sp"),
    ).toEqual(["split"]);
    expect(
      bashCompletions("hunk", "session", "reload", "test", "--", "diff", "--", "--mo"),
    ).toEqual([]);
    expect(bashCompletions("hunk", "--fast", "--mo")).toEqual(["--mode"]);
    expect(bashCompletions("hunk", "--fast", "--mode", "sp")).toEqual(["split"]);
    expect(bashCompletions("hunk", "--fast", "show", "--cu")).toEqual(["--cursor-line"]);
    expect(bashCompletions("hunk", "--fast", "sh")).toEqual(["show"]);
    expect(bashCompletions("hunk", "--fast", "--extension", "session", "--mode", "sp")).toEqual([
      "split",
    ]);
    expect(bashCompletions("hunk", "--fast", "--", "--mo")).toEqual([]);
  });

  /** Inspect context selection and native argument specifications without faking Zsh parsing. */
  function zshCompletions(autoload: boolean, ...words: string[]) {
    const quoted = words.map(quoteShell).join(" ");
    const load = autoload
      ? `fpath=(${quoteShell(directory)} $fpath); autoload -Uz _hunk`
      : `source ${quoteShell(zshPath)}`;
    const result = Bun.spawnSync([
      "zsh",
      "-fc",
      `compdef() { :; }; ${load};
       _arguments() { print -rl -- "$@"; print -r -- "CONTEXT:\${words[*]}"; };
       _files() { print -r -- FILE_FALLBACK; };
       words=(${quoted}); CURRENT=${words.length}; _hunk`,
    ]);
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().split("\n").filter(Boolean);
  }

  for (const autoload of [false, true]) {
    test.skipIf(!hasZsh)(
      `dispatches zsh completions (${autoload ? "autoloaded" : "sourced"})`,
      () => {
        const modeSpec = String.raw`*--mode=[layout mode\: auto, split, unified]:value:(auto split unified)`;
        expect(zshCompletions(autoload, "hunk", "session", "")).toContain("1:command:->command");
        expect(zshCompletions(autoload, "hunk", "diff", "--mode", "")).toContain(modeSpec);
        expect(
          zshCompletions(autoload, "hunk", "--extension", "session", "diff", "--mo"),
        ).toContain(modeSpec);
        expect(zshCompletions(autoload, "hunk", "--extension=session", "diff", "--mo")).toContain(
          modeSpec,
        );
        expect(zshCompletions(autoload, "hunk", "--extension", "se")).toContain(
          "*--extension=[load an extension entry file or directory (repeatable)]:value:_files",
        );
        expect(zshCompletions(autoload, "hunk", "--extension", "--mode", "")).toContain(
          "1:command:->command",
        );
        expect(zshCompletions(autoload, "hunk", "diff", "--", "--mo")).toEqual(["FILE_FALLBACK"]);
        expect(zshCompletions(autoload, "hunk", "diff", "--", "--mode", "")).toEqual([
          "FILE_FALLBACK",
        ]);
        expect(zshCompletions(autoload, "hunk", "diff", "--theme", "--mo")).toContain(
          "*--theme=[named theme override]:value:_files",
        );
        expect(zshCompletions(autoload, "hunk", "log", "-n", "session", "--au")).toContain(
          "*--author=[limit commits by author]:value:_files",
        );
        expect(zshCompletions(autoload, "hunk", "--he")).toContain("*--version[show version]");
        expect(zshCompletions(autoload, "hunk", "diff", "--he")).toContain("*--help[show help]");
        expect(
          zshCompletions(autoload, "hunk", "session", "reload", "test", "--", "diff", "--mo"),
        ).toContain("CONTEXT:hunk --mo");
        expect(zshCompletions(autoload, "hunk", "--fast", "--mode", "sp")).toContain(
          "CONTEXT:hunk --fast --mode sp",
        );
        expect(
          zshCompletions(autoload, "hunk", "--extension", "session data", "diff", "--mo"),
        ).toContain("CONTEXT:hunk --mo");
      },
    );
  }

  test.skipIf(!hasBash)("is valid bash syntax", () => {
    expect(Bun.spawnSync([bashExecutable!, "-n", bashPath]).exitCode).toBe(0);
  });

  test.skipIf(!hasZsh)("is valid zsh syntax", () => {
    expect(Bun.spawnSync(["zsh", "-n", zshPath]).exitCode).toBe(0);
  });
});
