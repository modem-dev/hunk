import { accessSync, constants, statfsSync } from "node:fs";

/** Return all actionable host prerequisite failures without mutating the machine. */
export async function collectInstallVmPreflightFailures(
  runtimeRoot: string,
  options: {
    platform?: NodeJS.Platform;
    arch?: string;
    dockerProbe?: () => number | Promise<number>;
    accessProbe?: (target: string) => void;
    availableBytes?: number;
  } = {},
) {
  const failures: string[] = [];
  if (
    (options.platform ?? process.platform) !== "linux" ||
    (options.arch ?? process.arch) !== "x64"
  ) {
    failures.push("Firecracker install scenarios require a Linux x86_64 host.");
  }
  const accessProbe =
    options.accessProbe ??
    ((target: string) => accessSync(target, constants.R_OK | constants.W_OK));
  for (const device of ["/dev/kvm", "/dev/net/tun"]) {
    try {
      accessProbe(device);
    } catch {
      failures.push(`${device} must exist and be readable/writable by the current user.`);
    }
  }
  const dockerProbe =
    options.dockerProbe ??
    (async () => {
      const proc = Bun.spawn(["docker", "info"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      return await proc.exited;
    });
  if ((await dockerProbe()) !== 0) {
    failures.push("Docker CLI and daemon access are required without sudo.");
  }
  const availableBytes =
    options.availableBytes ??
    (() => {
      const stats = statfsSync(runtimeRoot, { bigint: true });
      return Number(stats.bavail * stats.bsize);
    })();
  if (availableBytes < 6 * 1024 ** 3) failures.push("At least 6 GiB of free disk is required.");
  return failures;
}
