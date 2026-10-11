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
          const quotedItem = `'${name}:${option.description.replaceAll("'", "'\\''")}'`;
          expect(zshScript.includes(quotedItem)).toBe(true);
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
      expect(zshScript).toContain(`' ${flag}') items=(${values.join(" ")})`);
    }
  });

  test("register completion for bash and zsh", () => {
    expect(bashScript).toContain("complete -o default -F _hunk hunk");
    expect(zshScript.startsWith("#compdef hunk\n")).toBe(true);
    expect(zshScript).toContain("_describe");
    expect(zshScript).toContain("_files");
  });
});

describe("shell completion scripts in real shells", () => {
  const hasBash = process.platform !== "win32" && Bun.which("bash") !== null;
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

  function bashCompletions(...words: string[]) {
    const quoted = words.map((word) => `'${word}'`).join(" ");
    const result = Bun.spawnSync([
      "bash",
      "-c",
      `source "${bashPath}"; COMP_WORDS=(${quoted}); COMP_CWORD=${words.length - 1}; _hunk; printf '%s\\n' "\${COMPREPLY[@]}"`,
    ]);
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().split("\n").filter(Boolean);
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

  test.skipIf(!hasBash)("is valid bash syntax", () => {
    expect(Bun.spawnSync(["bash", "-n", bashPath]).exitCode).toBe(0);
  });

  test.skipIf(!hasZsh)("is valid zsh syntax", () => {
    expect(Bun.spawnSync(["zsh", "-n", zshPath]).exitCode).toBe(0);
  });
});
