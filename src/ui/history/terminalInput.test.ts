import { describe, expect, test } from "bun:test";
import { TerminalInputTokenizer } from "./terminalInput";

describe("TerminalInputTokenizer", () => {
  test("queues multiple navigation and action keys from one chunk", () => {
    const tokenizer = new TerminalInputTokenizer();

    expect(tokenizer.push("\x1b[B\r")).toEqual(["\x1b[B", "\r"]);
  });

  test("retains split CSI and mouse sequences until they are complete", () => {
    const tokenizer = new TerminalInputTokenizer();

    expect(tokenizer.push("\x1b[")).toEqual([]);
    expect(tokenizer.push("B/fi")).toEqual(["\x1b[B", "/", "f", "i"]);
    expect(tokenizer.push("\x1b[<0;12;")).toEqual([]);
    expect(tokenizer.push("4Mq")).toEqual(["\x1b[<0;12;4M", "q"]);
  });

  test("preserves UTF-8 characters split across byte chunks", () => {
    const tokenizer = new TerminalInputTokenizer();
    const bytes = Buffer.from("猫");

    expect(tokenizer.push(bytes.subarray(0, 2))).toEqual([]);
    expect(tokenizer.push(bytes.subarray(2))).toEqual(["猫"]);
  });

  test("flushes a standalone escape without consuming the next action", () => {
    const tokenizer = new TerminalInputTokenizer();

    expect(tokenizer.push("\x1b")).toEqual([]);
    expect(tokenizer.hasStandaloneEscape()).toBe(true);
    expect(tokenizer.flushStandaloneEscape()).toEqual(["\x1b"]);
    expect(tokenizer.push("q")).toEqual(["q"]);
  });
});
