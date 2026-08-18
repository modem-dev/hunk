import { describe, expect, test } from "bun:test";
import {
  createVimNavigationState,
  executeVimCommand,
} from "../examples/extensions/vim-navigation/state";

/** Record semantic executions made by the example grammar. */
function recordingState() {
  const calls: Array<{ id: string; options?: { count?: number } }> = [];
  const commands = {
    execute(id: string, options?: { count?: number }) {
      calls.push({ id, options });
      return true;
    },
  };
  return { calls, commands, state: createVimNavigationState(commands) };
}

const MAPPINGS = [
  { keys: "j", id: "hunk.review.stepDown", options: { count: 1 } },
  { keys: "k", id: "hunk.review.stepUp", options: { count: 1 } },
  { keys: "[", id: "hunk.review.previousHunk", options: { count: 1 } },
  { keys: "]", id: "hunk.review.nextHunk", options: { count: 1 } },
  { keys: "gg", id: "hunk.review.jumpToTop", options: undefined },
  { keys: "G", id: "hunk.review.jumpToBottom", options: undefined },
  { keys: "zt", id: "hunk.review.alignCurrentLineTop", options: undefined },
  { keys: "zz", id: "hunk.review.alignCurrentLineCenter", options: undefined },
  { keys: "zb", id: "hunk.review.alignCurrentLineBottom", options: undefined },
] as const;

describe("vim navigation example state", () => {
  for (const mapping of MAPPINGS) {
    test(`maps ${mapping.keys} to one ${mapping.id} execution`, () => {
      const { calls, state } = recordingState();

      for (const key of mapping.keys) {
        expect(state.handleKey({ sequence: key })).toBe("handled");
      }

      expect(calls).toEqual([{ id: mapping.id, options: mapping.options }]);
    });
  }

  test("maps counted Ctrl-D and Ctrl-U through public half-page commands", () => {
    const { calls, state } = recordingState();

    expect(state.handleKey({ sequence: "3" })).toBe("handled");
    expect(state.handleKey({ ctrl: true, name: "d" })).toBe("handled");
    expect(state.handleKey({ ctrl: true, name: "u" })).toBe("handled");

    expect(calls).toEqual([
      { id: "hunk.review.halfPageDown", options: { count: 3 } },
      { id: "hunk.review.halfPageUp", options: { count: 1 } },
    ]);
  });

  test("resolves a numeric relative motion into one atomic command call", () => {
    const { calls, state } = recordingState();

    expect(state.handleKey({ sequence: "3" })).toBe("handled");
    expect(state.handleKey({ sequence: "0" })).toBe("handled");
    expect(state.handleKey({ sequence: "]" })).toBe("handled");

    expect(calls).toEqual([{ id: "hunk.review.nextHunk", options: { count: 30 } }]);
  });

  test("caps long counts at the host maximum", () => {
    const { calls, state } = recordingState();
    for (const digit of "999999999") state.handleKey({ sequence: digit });
    state.handleKey({ sequence: "j" });

    expect(calls).toEqual([{ id: "hunk.review.stepDown", options: { count: 10_000 } }]);
  });

  test("passes semicolon and unsupported modifiers through, resetting pending counts", () => {
    const { calls, state } = recordingState();

    expect(state.handleKey({ sequence: "4" })).toBe("handled");
    expect(state.handleKey({ sequence: ";" })).toBe("pass");
    expect(state.handleKey({ meta: true, name: "j" })).toBe("pass");
    expect(state.handleKey({ option: true, name: "k" })).toBe("pass");
    expect(state.handleKey({ ctrl: true, option: true, name: "d" })).toBe("pass");
    expect(state.handleKey({ ctrl: true, shift: true, name: "u" })).toBe("pass");
    expect(state.handleKey({ sequence: "j" })).toBe("handled");

    expect(calls).toEqual([{ id: "hunk.review.stepDown", options: { count: 1 } }]);
  });

  test("executes the illustrative Ex commands and reports unsupported input", () => {
    const { calls, commands } = recordingState();

    expect(executeVimCommand("top", commands)).toBe("handled");
    expect(executeVimCommand(":bottom", commands)).toBe("handled");
    expect(executeVimCommand("  ", commands)).toBe("empty");
    expect(executeVimCommand("100", commands)).toBe("unknown");

    expect(calls).toEqual([
      { id: "hunk.review.jumpToTop", options: undefined },
      { id: "hunk.review.jumpToBottom", options: undefined },
    ]);
  });

  test("passes a bare zero and clears counts and invalid pending sequences", () => {
    const { calls, state } = recordingState();

    expect(state.handleKey({ sequence: "0" })).toBe("pass");
    expect(state.handleKey({ sequence: "4" })).toBe("handled");
    expect(state.handleKey({ sequence: "x" })).toBe("pass");
    expect(state.handleKey({ sequence: "j" })).toBe("handled");
    expect(state.handleKey({ sequence: "z" })).toBe("handled");
    expect(state.handleKey({ sequence: "x" })).toBe("pass");
    expect(state.handleKey({ sequence: "k" })).toBe("handled");

    expect(calls).toEqual([
      { id: "hunk.review.stepDown", options: { count: 1 } },
      { id: "hunk.review.stepUp", options: { count: 1 } },
    ]);
  });

  test("reset clears a pending count and sequence", () => {
    const { calls, state } = recordingState();

    state.handleKey({ sequence: "8" });
    state.handleKey({ sequence: "g" });
    state.reset();
    state.handleKey({ sequence: "j" });

    expect(calls).toEqual([{ id: "hunk.review.stepDown", options: { count: 1 } }]);
  });
});
