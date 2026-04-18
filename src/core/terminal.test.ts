import { describe, expect, test } from "bun:test";
import type { CliInput } from "./types";
import {
  openControllingTerminal,
  resolveRuntimeCliInput,
  shouldUseMouseForApp,
  shouldUsePagerMode,
  usesPipedPatchInput,
} from "./terminal";

function createPatchInput(file?: string, pager = false): CliInput {
  return {
    kind: "patch",
    file,
    options: {
      mode: "auto",
      pager,
    },
  };
}

describe("terminal runtime defaults", () => {
  test("treats stdin patch mode as pager-style when stdin is piped", () => {
    const input = createPatchInput("-", false);

    expect(usesPipedPatchInput(input, false)).toBe(true);
    expect(shouldUsePagerMode(input, false)).toBe(true);
    expect(resolveRuntimeCliInput(input, false).options.pager).toBe(true);
  });

  test("does not force pager mode for patch files or interactive stdin", () => {
    expect(usesPipedPatchInput(createPatchInput("changes.patch"), false)).toBe(false);
    expect(shouldUsePagerMode(createPatchInput("changes.patch"), false)).toBe(false);
    expect(shouldUsePagerMode(createPatchInput("-"), true)).toBe(false);
  });

  test("keeps explicit pager mode enabled", () => {
    const input = createPatchInput(undefined, true);

    expect(shouldUsePagerMode(input, true)).toBe(true);
    expect(resolveRuntimeCliInput(input, true).options.pager).toBe(true);
  });
});

describe("app mouse support", () => {
  test("enables mouse for interactive stdin", () => {
    expect(
      shouldUseMouseForApp({
        stdinIsTTY: true,
        hasControllingTerminal: false,
      }),
    ).toBe(true);
  });

  test("enables mouse when a controlling terminal is attached", () => {
    expect(
      shouldUseMouseForApp({
        stdinIsTTY: false,
        hasControllingTerminal: true,
      }),
    ).toBe(true);
  });

  test("disables mouse when no interactive terminal is available", () => {
    expect(
      shouldUseMouseForApp({
        stdinIsTTY: false,
        hasControllingTerminal: false,
      }),
    ).toBe(false);
  });
});

describe("controlling terminal attachment", () => {
  test("opens /dev/tty for read and closes the input stream", () => {
    const calls: Array<[string, string]> = [];
    let stdinDestroyed = false;

    const stdin = {
      destroy() {
        stdinDestroyed = true;
      },
    } as never;

    const controllingTerminal = openControllingTerminal({
      openSync(path, flags) {
        calls.push([String(path), String(flags)]);
        return 11;
      },
      createReadStream(fd) {
        expect(fd).toBe(11);
        return stdin;
      },
    });

    expect(controllingTerminal).not.toBeNull();
    expect(calls).toEqual([["/dev/tty", "r"]]);
    expect(controllingTerminal?.stdin).toBe(stdin);

    controllingTerminal?.close();
    expect(stdinDestroyed).toBe(true);
  });

  test("returns null when the controlling terminal cannot be opened", () => {
    const controllingTerminal = openControllingTerminal({
      openSync() {
        throw new Error("no tty");
      },
      createReadStream() {
        throw new Error("unreachable");
      },
    });

    expect(controllingTerminal).toBeNull();
  });
});
