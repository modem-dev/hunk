import { describe, expect, test } from "bun:test";
import {
  buildBrokerChallengeTranscript,
  buildCallerRequestTranscript,
} from "@hunk/session-broker-core";
import {
  decodeBase64Url,
  encodeBase64Url,
  importEd25519PrivateKey,
  importEd25519PublicKey,
  webSessionBrokerCrypto,
} from "./crypto";

function hex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

describe("session broker Ed25519 crypto", () => {
  test("round-trips canonical base64url empty and edge values", () => {
    expect(encodeBase64Url(new Uint8Array())).toBe("");
    expect(decodeBase64Url("")).toEqual(new Uint8Array());
    expect(decodeBase64Url("A")).toBeNull();
    expect(decodeBase64Url("AA==")).toBeNull();
    expect(decodeBase64Url("AB")).toBeNull();
    expect(decodeBase64Url("AA")).toEqual(new Uint8Array([0]));
  });

  test("matches the golden transcript signature fixture", async () => {
    // RFC 8032 test vector 1 key material wrapped in standard PKCS#8/SPKI containers.
    const privateKey = await importEd25519PrivateKey(
      new Uint8Array([
        ...hex("302e020100300506032b657004220420"),
        ...hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"),
      ]),
    );
    const publicKey = await importEd25519PublicKey(
      new Uint8Array([
        ...hex("302a300506032b6570032100"),
        ...hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
      ]),
    );
    const transcript = buildBrokerChallengeTranscript({
      role: "caller",
      appId: "dev.example",
      generation: "generation-1",
      endpoint: "http://127.0.0.1:47657/broker",
      keyId: "caller-key-1",
      grantId: "caller-grant-1",
      initiatorNonce: "nonce-a",
      responderNonce: "nonce-b",
      proposal: { brokerRevision: 1, appRevision: 7, features: ["z", "a"] },
    });
    const signature = await webSessionBrokerCrypto.sign(privateKey, transcript);

    expect(encodeBase64Url(signature)).toBe(
      "u1r3Q-Fji-3PYthUZ8TudnJm2Gw3b0jJqFYddzFMzpXmgshYVY9OL2iKD0zbEy2tWcm5L_evmmKAYClbc4_sAg",
    );
    expect(await webSessionBrokerCrypto.verify(publicKey, signature, transcript)).toBe(true);

    expect(
      encodeBase64Url(
        await webSessionBrokerCrypto.sha256(new TextEncoder().encode('{"action":"list"}')),
      ),
    ).toBe("WE52AIFcTHUuQvjzwAqkvxWX8TuwjtXeRDszCX4aF1E");

    const requestTranscript = buildCallerRequestTranscript({
      appId: "dev.example",
      generation: "generation-1",
      callerSessionId: "caller-session-1",
      keyId: "caller-key-1",
      grantId: "caller-grant-1",
      helloTranscriptHash: "hello-hash",
      method: "post",
      target: "/broker?a=1&b=2",
      bodyDigest: "body-hash",
      requestId: "request-1",
      sequence: "1",
    });
    expect(encodeBase64Url(await webSessionBrokerCrypto.sign(privateKey, requestTranscript))).toBe(
      "I9FPiLt4mNyEzZRIYNPFffwTRf-SutIK9ml9BdJFT-6JQs6i58G6sAfx-JJt8N3yI_VzDFJXFLv_4JbyaX5kDg",
    );
  });
});
