import { describe, expect, test } from "bun:test";
import type { CliInput } from "../src/core/types";
import { openControllingTerminal, resolveRuntimeCliInput, shouldUsePagerMode, usesPipedPatchInput } from "../src/core/terminal";

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

describe("controlling terminal attachment", () => {
  test("opens /dev/tty for read and write and closes both streams", () => {
    const calls: Array<[string, string]> = [];
    let stdinDestroyed = false;
    let stdoutDestroyed = false;

    const stdin = {
      destroy() {
        stdinDestroyed = true;
      },
    } as never;
    const stdout = {
      destroy() {
        stdoutDestroyed = true;
      },
    } as never;

    const controllingTerminal = openControllingTerminal({
      openSync(path, flags) {
        calls.push([String(path), String(flags)]);
        return flags === "r" ? 11 : 12;
      },
      createReadStream(fd) {
        expect(fd).toBe(11);
        return stdin;
      },
      createWriteStream(fd) {
        expect(fd).toBe(12);
        return stdout;
      },
    });

    expect(controllingTerminal).not.toBeNull();
    expect(calls).toEqual([
      ["/dev/tty", "r"],
      ["/dev/tty", "w"],
    ]);
    expect(controllingTerminal?.stdin).toBe(stdin);
    expect(controllingTerminal?.stdout).toBe(stdout);

    controllingTerminal?.close();
    expect(stdinDestroyed).toBe(true);
    expect(stdoutDestroyed).toBe(true);
  });

  test("returns null when the controlling terminal cannot be opened", () => {
    const controllingTerminal = openControllingTerminal({
      openSync() {
        throw new Error("no tty");
      },
      createReadStream() {
        throw new Error("unreachable");
      },
      createWriteStream() {
        throw new Error("unreachable");
      },
    });

    expect(controllingTerminal).toBeNull();
  });
});
