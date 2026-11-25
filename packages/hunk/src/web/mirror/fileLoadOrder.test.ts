import { describe, expect, test } from "bun:test";
import { ClientFileLoadOrder } from "./fileLoadOrder";

/** An order over files `a`..`f` read in reverse, so read indexes differ from positions. */
function createTestOrder(wanted: () => readonly (readonly string[])[]) {
  const keys = ["a", "b", "c", "d", "e", "f"];
  const readIndexByKey = new Map(keys.map((key, position) => [key, keys.length - 1 - position]));
  return { order: new ClientFileLoadOrder(keys, readIndexByKey, wanted), readIndexByKey };
}

/** Every index the order hands out, in turn, as file keys. */
function drainTestOrder(order: ClientFileLoadOrder, readIndexByKey: ReadonlyMap<string, number>) {
  const keyByIndex = new Map([...readIndexByKey].map(([key, index]) => [index, key]));
  const keys: string[] = [];
  for (let index = order.next(); index !== undefined; index = order.next()) {
    keys.push(keyByIndex.get(index)!);
  }
  return keys;
}

describe("ClientFileLoadOrder", () => {
  test("reads in document order when nothing is wanted", () => {
    const { order, readIndexByKey } = createTestOrder(() => [[], []]);

    expect(drainTestOrder(order, readIndexByKey)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("serves a target, then the viewport, then the rest, each file once", () => {
    const { order, readIndexByKey } = createTestOrder(() => [["f"], ["d", "e", "f"]]);

    expect(drainTestOrder(order, readIndexByKey)).toEqual(["f", "d", "e", "a", "b", "c"]);
  });

  // Intent: a jump made while files load reorders every read that has not started.
  test("follows priorities that change between picks", () => {
    let wanted: readonly (readonly string[])[] = [[], ["a", "b"]];
    const { order, readIndexByKey } = createTestOrder(() => wanted);
    const keyOf = (index: number | undefined) =>
      [...readIndexByKey].find(([, candidate]) => candidate === index)?.[0];

    expect(keyOf(order.next())).toBe("a");
    wanted = [["e"], ["d"]];
    expect(keyOf(order.next())).toBe("e");
    expect(keyOf(order.next())).toBe("d");
    expect(drainTestOrder(order, readIndexByKey)).toEqual(["b", "c", "f"]);
  });

  test("ignores wanted keys that have nothing to read", () => {
    const { order, readIndexByKey } = createTestOrder(() => [["missing"], []]);

    expect(drainTestOrder(order, readIndexByKey)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});
