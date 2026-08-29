import { describe, expect, test } from "bun:test";
import {
  agentOptionFlagName,
  isHighlightTone,
  optionKeyFromFlag,
  type AgentCommandOption,
  SESSION_AGENT_COMMAND_LIST,
  SESSION_AGENT_COMMANDS,
  SESSION_COMMENT_COMMAND_LIST,
  SESSION_HIGHLIGHT_COMMAND_LIST,
  type SessionCommandOptions,
} from "./surface";

const FLAG_TOKEN_PATTERN = /--[a-z][a-z-]*/g;

describe("session agent command surface", () => {
  test("covers every daemon action with a uniquely named command", () => {
    const names = SESSION_AGENT_COMMAND_LIST.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
    expect(SESSION_COMMENT_COMMAND_LIST.map((spec) => spec.name)).toEqual([
      "session comment add",
      "session comment apply",
      "session comment list",
      "session comment rm",
      "session comment clear",
    ]);
    expect(SESSION_HIGHLIGHT_COMMAND_LIST.map((spec) => spec.name)).toEqual([
      "session highlight add",
      "session highlight clear",
    ]);
  });

  test("declares each option flag once per command", () => {
    for (const spec of SESSION_AGENT_COMMAND_LIST) {
      const flagNames = spec.options.map(agentOptionFlagName);
      expect(new Set(flagNames).size).toBe(flagNames.length);
    }
  });

  test("mentions every declared option in the command synopsis", () => {
    for (const spec of SESSION_AGENT_COMMAND_LIST) {
      const synopsis = spec.synopsis.join(" ");
      for (const option of spec.options) {
        expect(synopsis).toContain(agentOptionFlagName(option));
      }
    }
  });

  test("only references declared flags in synopsis and examples", () => {
    for (const spec of SESSION_AGENT_COMMAND_LIST) {
      const declared = new Set(spec.options.map(agentOptionFlagName));
      const referenced = [...spec.synopsis, ...(spec.examples ?? [])]
        .join(" ")
        .match(FLAG_TOKEN_PATTERN);
      for (const flag of referenced ?? []) {
        expect(declared).toContain(flag);
      }
    }
  });

  test("keeps synopsis lines runnable as `hunk ...` invocations", () => {
    for (const spec of SESSION_AGENT_COMMAND_LIST) {
      for (const line of spec.synopsis) {
        expect(line.startsWith(`hunk ${spec.name}`)).toBe(true);
      }
    }
  });

  test("camelizes flag definitions into Commander option keys", () => {
    expect(optionKeyFromFlag("--old-line <n>")).toBe("oldLine");
    expect(optionKeyFromFlag("--next-comment")).toBe("nextComment");
    expect(optionKeyFromFlag("--json")).toBe("json");
  });

  test("declares every constraint flag as an option on its command", () => {
    for (const spec of SESSION_AGENT_COMMAND_LIST) {
      const declared = new Set(spec.options.map(agentOptionFlagName));
      for (const constraint of spec.constraints ?? []) {
        for (const flag of constraint.flags) {
          expect(declared).toContain(flag.split(" ")[0]!);
        }
      }
    }
  });

  test("derives parsed-option shapes from the specs at compile time", () => {
    // These assignments are the assertions; `bun run typecheck` enforces them.
    const navigate: SessionCommandOptions<"navigate"> = { repo: ".", hunk: 2, json: true };
    // @ts-expect-error --hunk parses to a number, not a string
    const badHunk: SessionCommandOptions<"navigate"> = { hunk: "2" };
    // @ts-expect-error comment add requires --file and --summary
    const missingRequired: SessionCommandOptions<"comment-add"> = { newLine: 3 };
    const add: SessionCommandOptions<"comment-add"> = {
      file: "a.ts",
      summary: "note",
      newLine: 3,
    };
    // @ts-expect-error unknown flags are rejected
    const unknownFlag: SessionCommandOptions<"list"> = { repo: "." };

    expect([navigate, badHunk, missingRequired, add, unknownFlag]).toBeTruthy();
  });

  test("marks navigation and comment targets with positive-int parsing", () => {
    const navigateOptions: readonly AgentCommandOption[] = SESSION_AGENT_COMMANDS.navigate.options;
    const targetFlags = ["--hunk", "--old-line", "--new-line"];
    for (const option of navigateOptions) {
      if (targetFlags.includes(agentOptionFlagName(option))) {
        expect(option.parse).toBe("positiveInt");
      }
    }
  });

  test("parses highlight offsets as 0-based start and positive exclusive end", () => {
    const options: readonly AgentCommandOption[] = SESSION_AGENT_COMMANDS["highlight-add"].options;
    const parseByFlag = new Map(
      options.map((option) => [agentOptionFlagName(option), option.parse]),
    );
    // `--start` accepts 0 because offsets are 0-based; `--end` is exclusive so it starts at 1.
    expect(parseByFlag.get("--start")).toBe("nonNegativeInt");
    expect(parseByFlag.get("--end")).toBe("positiveInt");
  });

  test("recognizes exactly the six shared highlight tones", () => {
    for (const tone of ["match", "current", "info", "warning", "error", "dim"]) {
      expect(isHighlightTone(tone)).toBe(true);
    }
    expect(isHighlightTone("loud")).toBe(false);
  });
});
