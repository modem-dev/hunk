import { describe, expect, test } from "bun:test";
import {
  chunkBase64,
  encodeDelete,
  encodePlace,
  encodeSupportQuery,
  encodeTransmit,
  MAX_CHUNK_BYTES,
} from "./escapes";

// Control bytes are built from char codes here for the same reason the encoder
// does it: a literal ESC in a source file is invisible and survives editing badly.
const ESC = String.fromCharCode(0x1b);
const BACKSLASH = String.fromCharCode(0x5c);
const START = `${ESC}_G`;
const END = ESC + BACKSLASH;

/** Pulls the key section out of a sequence, so assertions read as key sets. */
function keysOf(sequence: string): string {
  const body = sequence.slice(START.length, sequence.length - END.length);
  const semi = body.indexOf(";");
  return semi < 0 ? body : body.slice(0, semi);
}

/** Pulls the base64 payload out of a sequence. */
function payloadOf(sequence: string): string {
  const body = sequence.slice(START.length, sequence.length - END.length);
  return body.slice(body.indexOf(";") + 1);
}

describe("sequence envelope", () => {
  test("wraps every sequence in the APC introducer and terminator", () => {
    const seq = encodePlace({ id: 1 });
    expect(seq.startsWith(START)).toBe(true);
    expect(seq.endsWith(END)).toBe(true);
  });
});

describe("encodePlace", () => {
  test("emits source rectangle, cell box, and stacking keys", () => {
    const seq = encodePlace({
      id: 1,
      srcX: 0,
      srcY: 32,
      srcW: 128,
      srcH: 64,
      cols: 40,
      rows: 12,
      z: -1,
      keepCursor: true,
    });
    expect(keysOf(seq)).toBe("a=p,i=1,x=0,y=32,w=128,h=64,c=40,r=12,z=-1,C=1");
  });

  test("omits keys that were not supplied", () => {
    expect(keysOf(encodePlace({ id: 9 }))).toBe("a=p,i=9");
  });

  test("keeps a zero z-index rather than dropping it as falsy", () => {
    expect(keysOf(encodePlace({ id: 1, z: 0 }))).toContain("z=0");
  });

  test("marks virtual placements for placeholder addressing", () => {
    expect(keysOf(encodePlace({ id: 4, cols: 10, rows: 4, virtual: true }))).toContain("U=1");
  });
});

describe("encodeTransmit", () => {
  test("sends a small payload as a single sequence with no continuation flag", () => {
    const seqs = encodeTransmit(new Uint8Array([1, 2, 3, 4]), { id: 1, width: 1, height: 1 });
    expect(seqs).toHaveLength(1);
    expect(keysOf(seqs[0]!)).toBe("a=t,f=32,t=d,i=1,s=1,v=1");
  });

  test("chunks large payloads and flags all but the last", () => {
    // 9000 raw bytes base64-encodes to 12000 chars, which spans three chunks.
    const seqs = encodeTransmit(new Uint8Array(9000), { id: 2, width: 50, height: 45 });
    expect(seqs).toHaveLength(3);
    expect(keysOf(seqs[0]!)).toContain("m=1");
    expect(keysOf(seqs[1]!)).toBe("m=1");
    expect(keysOf(seqs[2]!)).toBe("m=0");
  });

  test("carries the full key set only on the first chunk", () => {
    const seqs = encodeTransmit(new Uint8Array(9000), { id: 2, width: 50, height: 45 });
    expect(keysOf(seqs[0]!)).toContain("i=2");
    expect(keysOf(seqs[1]!)).not.toContain("i=2");
  });

  test("keeps every non-final chunk at the protocol limit", () => {
    const seqs = encodeTransmit(new Uint8Array(9000), { id: 2, width: 50, height: 45 });
    expect(payloadOf(seqs[0]!)).toHaveLength(MAX_CHUNK_BYTES);
    expect(payloadOf(seqs[1]!)).toHaveLength(MAX_CHUNK_BYTES);
    expect(payloadOf(seqs[2]!).length).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
  });

  test("round-trips the payload through base64", () => {
    const source = new Uint8Array([0, 127, 128, 255, 42]);
    const seqs = encodeTransmit(source, { id: 1, width: 5, height: 1 });
    expect([...Buffer.from(payloadOf(seqs[0]!), "base64")]).toEqual([...source]);
  });

  test("flags zlib payloads with o=z", () => {
    const seqs = encodeTransmit(new Uint8Array(4), {
      id: 1,
      width: 1,
      height: 1,
      compressed: true,
    });
    expect(keysOf(seqs[0]!)).toContain("o=z");
  });

  test("switches to the combined transmit-and-place action when display is set", () => {
    const seqs = encodeTransmit(new Uint8Array(4), {
      id: 1,
      width: 1,
      height: 1,
      display: { cols: 8, rows: 2, z: -1 },
    });
    const keys = keysOf(seqs[0]!);
    expect(keys.startsWith("a=T")).toBe(true);
    expect(keys).toContain("c=8");
    expect(keys).toContain("z=-1");
  });

  test("selects the medium key for shared memory", () => {
    const seqs = encodeTransmit(new Uint8Array(4), { id: 1, medium: "shared", format: 100 });
    expect(keysOf(seqs[0]!)).toContain("t=s");
  });

  test("does not require dimensions for PNG, which is self-describing", () => {
    expect(() => encodeTransmit(new Uint8Array(4), { id: 1, format: 100 })).not.toThrow();
  });

  test("rejects raw pixel data sent without dimensions", () => {
    expect(() => encodeTransmit(new Uint8Array(4), { id: 1, format: 32 })).toThrow(
      /require width and height/,
    );
  });
});

describe("chunkBase64", () => {
  test("returns one empty chunk for empty input so a sequence is still emitted", () => {
    expect(chunkBase64("")).toEqual([""]);
  });

  test("rejects chunk sizes that would split a base64 quantum", () => {
    expect(() => chunkBase64("AAAA", 3)).toThrow(/multiple of 4/);
  });
});

describe("encodeDelete", () => {
  test("uses the lowercase selector to keep image data resident", () => {
    expect(keysOf(encodeDelete({ kind: "id", id: 7 }))).toBe("a=d,d=i,i=7");
  });

  test("uses the uppercase selector to free stored pixels", () => {
    expect(keysOf(encodeDelete({ kind: "id", id: 7 }, true))).toBe("a=d,d=I,i=7");
  });

  test("targets a single placement when one is named", () => {
    expect(keysOf(encodeDelete({ kind: "id", id: 7, placementId: 3 }))).toBe("a=d,d=i,i=7,p=3");
  });

  test("encodes cell, range, and z-index scopes", () => {
    expect(keysOf(encodeDelete({ kind: "cell", column: 4, row: 9 }))).toBe("a=d,d=p,x=4,y=9");
    expect(keysOf(encodeDelete({ kind: "idRange", from: 10, to: 20 }))).toBe("a=d,d=r,x=10,y=20");
    expect(keysOf(encodeDelete({ kind: "z", z: -1 }))).toBe("a=d,d=z,z=-1");
    expect(keysOf(encodeDelete({ kind: "all" }))).toBe("a=d,d=a");
  });
});

describe("encodeSupportQuery", () => {
  test("asks about a throwaway id so a live image is never disturbed", () => {
    const seq = encodeSupportQuery(31);
    expect(keysOf(seq)).toBe("a=q,i=31,s=1,v=1,f=24");
    expect(payloadOf(seq)).toBe("AAAA");
  });
});
