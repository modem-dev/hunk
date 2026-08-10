import { describe, expect, test } from "bun:test";
import { parseTailscaleBrowserOrigin, parseTailscaleIpv4 } from "./tailscale";

describe("Tailscale browser addresses", () => {
  test("accepts only canonical IPv4 addresses in Tailscale's CGNAT range", () => {
    expect(parseTailscaleIpv4("100.64.0.1")).toBe("100.64.0.1");
    expect(parseTailscaleIpv4("100.127.255.254\n")).toBe("100.127.255.254");
    for (const value of ["100.63.0.1", "100.128.0.1", "192.168.1.2", "100.064.0.1", "::1"])
      expect(parseTailscaleIpv4(value)).toBeNull();
  });

  test("accepts only exact plain-HTTP tailnet origins on the daemon port", () => {
    expect(parseTailscaleBrowserOrigin("http://100.70.1.2:47657", 47657)).toBe(
      "http://100.70.1.2:47657",
    );
    for (const value of [
      "https://100.70.1.2:47657",
      "http://100.70.1.2:1234",
      "http://100.70.1.2:47657/path",
      "http://user@100.70.1.2:47657",
      "http://127.0.0.1:47657",
      "http://attacker.invalid:47657",
    ])
      expect(parseTailscaleBrowserOrigin(value, 47657)).toBeNull();
  });
});
