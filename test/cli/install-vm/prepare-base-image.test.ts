import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

const requiredToolsAvailable = ["bash", "jq", "tar"].every(
  (tool) => Bun.spawnSync(["sh", "-c", `command -v "$1" >/dev/null`, "sh", tool]).exitCode === 0,
);

/** Return the SHA-256 digest of one local fixture file. */
function sha256(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Return every relative path below one test directory. */
function listTree(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(current, entry.name);
    const relative = path.relative(root, child);
    return entry.isDirectory() ? [relative, ...listTree(root, child)] : [relative];
  });
}

test.skipIf(process.platform !== "linux" || !requiredToolsAvailable)(
  "base-image preparation removes partial disks after a build failure",
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "hunk-install-vm-base-cleanup-"));
    const cache = path.join(root, "cache");
    const downloads = path.join(cache, "downloads");
    const archive = path.join(root, "firecracker-archive");
    const nodeArchive = path.join(root, "node-archive");
    const stubs = path.join(root, "bin");
    const scratch = path.join(root, "scratch");
    mkdirSync(downloads, { recursive: true });
    mkdirSync(path.join(archive, "release-v1.0.0-x86_64"), { recursive: true });
    mkdirSync(path.join(nodeArchive, "node-v1.0.0-linux-x64"), { recursive: true });
    mkdirSync(stubs);
    mkdirSync(scratch);

    try {
      const firecracker = path.join(archive, "release-v1.0.0-x86_64", "firecracker-v1.0.0-x86_64");
      writeFileSync(firecracker, "#!/bin/sh\nexit 0\n");
      chmodSync(firecracker, 0o755);

      const firecrackerTar = path.join(downloads, "firecracker-1.0.0.tgz");
      const nodeTar = path.join(downloads, "node.tar.xz");
      expect(Bun.spawnSync(["tar", "-czf", firecrackerTar, "-C", archive, "."]).exitCode).toBe(0);
      expect(Bun.spawnSync(["tar", "-cJf", nodeTar, "-C", nodeArchive, "."]).exitCode).toBe(0);
      writeFileSync(path.join(downloads, "vmlinux"), "kernel\n");
      writeFileSync(path.join(downloads, "rootfs.squashfs"), "rootfs\n");

      const unsquashfs = path.join(stubs, "unsquashfs");
      writeFileSync(
        unsquashfs,
        '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = -d ]; then mkdir -p "$2"; exit 0; fi\n  shift\ndone\nexit 2\n',
      );
      chmodSync(unsquashfs, 0o755);
      const mkfs = path.join(stubs, "mkfs.ext4");
      writeFileSync(mkfs, "#!/bin/sh\nexit 23\n");
      chmodSync(mkfs, 0o755);

      const pinsPath = path.join(root, "pins.json");
      writeFileSync(
        pinsPath,
        `${JSON.stringify({
          firecracker: {
            version: "1.0.0",
            url: "https://example.test/firecracker",
            sha256: sha256(firecrackerTar),
          },
          kernel: {
            version: "1.0.0",
            url: "https://example.test/kernel",
            sha256: sha256(path.join(downloads, "vmlinux")),
          },
          rootfs: {
            version: "1.0.0",
            url: "https://example.test/rootfs",
            sha256: sha256(path.join(downloads, "rootfs.squashfs")),
          },
          node: {
            version: "1.0.0",
            url: "https://example.test/node",
            sha256: sha256(nodeTar),
          },
        })}\n`,
      );

      const script = path.join(import.meta.dir, "guest", "prepare-base-image.sh");
      const result = Bun.spawnSync(["bash", script, cache, pinsPath], {
        env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, TMPDIR: scratch },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(23);
      expect(listTree(cache).filter((entry) => entry.includes(".partial."))).toEqual([]);
      expect(readdirSync(scratch)).toEqual([]);
      expect(existsSync(path.join(cache, "base", "rootfs.base.ext4"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
