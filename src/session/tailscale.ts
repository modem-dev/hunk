/** Parse one canonical IPv4 address and require Tailscale's 100.64.0.0/10 range. */
export function parseTailscaleIpv4(value: string) {
  const trimmed = value.trim();
  const parts = trimmed.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
  ) {
    return null;
  }
  const octets = parts.map(Number);
  if (octets[0] !== 100 || octets[1]! < 64 || octets[1]! > 127) return null;
  return octets.join(".");
}

/** Accept only one daemon-issued plain-HTTP tailnet IPv4 origin on the broker port. */
export function parseTailscaleBrowserOrigin(value: unknown, expectedPort: number) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      Number(url.port || "80") !== expectedPort ||
      !parseTailscaleIpv4(url.hostname)
    ) {
      return null;
    }
    return `http://${url.hostname}:${expectedPort}`;
  } catch {
    return null;
  }
}
