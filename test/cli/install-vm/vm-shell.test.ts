import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDockerVmShellCommand } from "./contract";
import { InstallVmCommandRunner } from "./runner";
import { acquireInstallVmRuntimeLock } from "./runtime-lock";
import {
  parseVmShellArgs,
  prepareVmShellHunkInput,
  removeVmShellHunkInput,
  runWithVmShellRuntime,
  stageVmShellHunkInput,
  validateVmShellTty,
} from "./vm-shell";

const harnessRoot = import.meta.dir;

describe("disposable VM shell", () => {
  test("parses only one optional local Hunk installation", () => {
    expect(parseVmShellArgs([])).toEqual({ withHunk: false });
    expect(parseVmShellArgs(["--with-hunk"])).toEqual({ withHunk: true });
    expect(() => parseVmShellArgs(["--with-hunk", "--with-hunk"])).toThrow("only once");
    expect(() => parseVmShellArgs(["--keep"])).toThrow("Unknown VM shell option");
  });

  test("requires an interactive terminal", () => {
    expect(() => validateVmShellTty(true, true)).not.toThrow();
    expect(() => validateVmShellTty(false, true)).toThrow("interactive stdin and stdout");
    expect(() => validateVmShellTty(true, false)).toThrow("interactive stdin and stdout");
  });

  test("builds an interactive cache-only least-privilege Docker invocation", () => {
    const command = buildDockerVmShellCommand("hunk-install-vm:test", "/safe/cache", {
      uid: 1000,
      gid: 1000,
    });
    expect(command).toContain("--interactive");
    expect(command).toContain("--tty");
    expect(command).toContain("--stop-timeout=30");
    expect(command).toContain("--cap-drop=ALL");
    expect(command).toContain("--cap-add=NET_ADMIN");
    expect(command).toContain("--cap-add=CHOWN");
    expect(command).toContain("--cap-add=DAC_OVERRIDE");
    expect(command).toContain("--device=/dev/kvm");
    expect(command).toContain("--device=/dev/net/tun");
    expect(command).toContain("--security-opt=no-new-privileges");
    expect(command).toContain("--read-only");
    expect(command).toContain("--tmpfs=/tmp:rw,nosuid,nodev,mode=1777");
    expect(command).toContain("--tmpfs=/run:rw,nosuid,nodev,mode=755");
    expect(command).toContain("--mount=type=bind,src=/safe/cache,dst=/cache");
    expect(command).toContain("--entrypoint=/opt/install-vm/vm-shell-controller.sh");
    expect(command.filter((argument) => argument.startsWith("--mount="))).toHaveLength(1);
    expect(command.join(" ")).not.toContain("docker.sock");
    expect(command.join(" ")).not.toContain("/repo");
    expect(command.join(" ")).not.toContain("/fixtures");
    expect(command.join(" ")).not.toContain("/artifacts");
    expect(command.join(" ")).not.toContain("INSTALL_VM_SCENARIOS");
    expect(command.join(" ")).not.toContain("WITH_HUNK");
    expect(command.join(" ")).not.toContain("/hunk-input");

    const withHunk = buildDockerVmShellCommand(
      "hunk-install-vm:test",
      "/safe/cache",
      { uid: 1000, gid: 1000 },
      { hunkInputDir: "/safe/hunk-input" },
    );
    expect(withHunk).toContain("--env=WITH_HUNK=1");
    expect(withHunk).toContain("--mount=type=bind,src=/safe/hunk-input,dst=/hunk-input,readonly");
    expect(withHunk.filter((argument) => argument.startsWith("--mount="))).toHaveLength(2);
    expect(() => buildDockerVmShellCommand("image", "/unsafe,cache", { uid: 1, gid: 1 })).toThrow(
      "Unsafe Docker bind path",
    );
    expect(() =>
      buildDockerVmShellCommand(
        "image",
        "/safe/cache",
        { uid: 1, gid: 1 },
        { hunkInputDir: "/unsafe,input" },
      ),
    ).toThrow("Unsafe Docker bind path");
  });

  test("stages only a regular binary and the source-install skills layout", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "hunk-vm-shell-stage-"));
    const outside = mkdtempSync(path.join(tmpdir(), "hunk-vm-shell-outside-"));
    try {
      const runtime = path.join(repo, "tmp", "install-vm");
      const staging = path.join(runtime, "vm-shell-input");
      mkdirSync(path.join(repo, "dist", "skills", "hunk-review"), { recursive: true });
      writeFileSync(path.join(repo, "dist", "hunk"), "fresh binary\n");
      writeFileSync(path.join(repo, "dist", "skills", "hunk-review", "SKILL.md"), "fresh skill\n");
      mkdirSync(runtime, { recursive: true });

      expect(stageVmShellHunkInput(repo, staging)).toBe(staging);
      expect(readFileSync(path.join(staging, "hunk"), "utf8")).toBe("fresh binary\n");
      expect(
        readFileSync(path.join(staging, "hunkdiff", "skills", "hunk-review", "SKILL.md"), "utf8"),
      ).toBe("fresh skill\n");
      if (process.platform !== "win32") {
        expect(statSync(path.join(staging, "hunk")).mode & 0o777).toBe(0o755);
      }

      removeVmShellHunkInput(repo, staging);
      expect(existsSync(staging)).toBe(false);
      symlinkSync(outside, staging);
      expect(() => stageVmShellHunkInput(repo, staging)).toThrow("symlink ancestor");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("runs a fresh host build before replacing stale staged Hunk files", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "hunk-vm-shell-build-"));
    try {
      const runtime = path.join(repo, "tmp", "install-vm");
      const staging = path.join(runtime, "vm-shell-input");
      mkdirSync(staging, { recursive: true });
      writeFileSync(path.join(staging, "hunk"), "stale staged binary\n");
      let command: string[] | undefined;
      let cwd: string | undefined;
      const runner = {
        run: async (receivedCommand: string[], options: { cwd?: string } = {}) => {
          command = receivedCommand;
          cwd = options.cwd;
          expect(existsSync(staging)).toBe(false);
          mkdirSync(path.join(repo, "dist", "skills", "hunk-review"), { recursive: true });
          writeFileSync(path.join(repo, "dist", "hunk"), "fresh build\n");
          chmodSync(path.join(repo, "dist", "hunk"), 0o755);
          writeFileSync(path.join(repo, "dist", "skills", "hunk-review", "SKILL.md"), "skill\n");
        },
      };

      await prepareVmShellHunkInput(repo, staging, runner, "/test/bun");
      expect(command).toEqual(["/test/bun", "run", "build:bin"]);
      expect(cwd).toBe(repo);
      expect(readFileSync(path.join(staging, "hunk"), "utf8")).toBe("fresh build\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("releases the shared runtime lock after host orchestration fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hunk-vm-shell-runtime-"));
    const lockPath = path.join(root, ".lock");
    const runner = new InstallVmCommandRunner();
    try {
      await expect(
        runWithVmShellRuntime(lockPath, runner, async () => {
          throw new Error("controller failed");
        }),
      ).rejects.toThrow("controller failed");
      const release = acquireInstallVmRuntimeLock(lockPath);
      release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the guest lifecycle disposable and bounded", () => {
    const dockerIgnore = readFileSync(path.join(harnessRoot, ".dockerignore"), "utf8");
    const hostRunner = readFileSync(path.join(harnessRoot, "vm-shell.ts"), "utf8");
    const script = readFileSync(path.join(harnessRoot, "vm-shell-controller.sh"), "utf8");
    expect(dockerIgnore).toContain("!vm-shell-controller.sh");
    expect(hostRunner).toContain("terminationGraceMs: 30_000");
    expect(script).toContain("set -Eeuo pipefail");
    expect(script).toContain("[[ -t 0 && -t 1 ]]");
    expect(script).toContain("HOST_UID is required");
    expect(script).toContain("HOST_GID is required");
    expect(script).toContain("trap cleanup EXIT");
    for (const [signal, exitCode] of [
      ["HUP", 129],
      ["INT", 130],
      ["QUIT", 131],
      ["TERM", 143],
    ] as const) {
      expect(script).toContain(`trap 'exit ${exitCode}' ${signal}`);
    }
    expect(script).toContain("kill -WINCH");
    expect(script).toContain("kill -TERM");
    expect(script).toContain("kill -KILL");
    expect(script).toContain("ssh-keygen -q -t ed25519");
    expect(script).toContain("cp --reflink=auto --sparse=always");
    expect(script).toContain('-tt "root@$guest_ip"');
    expect(script).toContain("</dev/tty &");
    expect(script).toContain('"vcpu_count": 2, "mem_size_mib": 2048');
    expect(script).toContain('egress_chain="HUNKVM_$$"');
    expect(script).toContain('iptables -A "$egress_chain" ! -s "$guest_ip/32" -j DROP');
    for (const blockedDestination of [
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ]) {
      expect(script).toContain(blockedDestination);
    }
    expect(script).toContain('iptables -A "$egress_chain" -d "$blocked_destination" -j REJECT');
    expect(script).toContain('iptables -A "$egress_chain" -s "$guest_ip/32" -j ACCEPT');
    expect(script).toContain('iptables -A FORWARD -i "$tap" -o "$uplink" -j "$egress_chain"');
    expect(script).toContain('iptables -D FORWARD -i "$tap" -o "$uplink" -j "$egress_chain"');
    expect(script).toContain('iptables -F "$egress_chain"');
    expect(script).toContain('iptables -X "$egress_chain"');
    expect(script).toContain('iptables -A FORWARD -d "$guest_ip/32"');
    expect(script).toContain('iptables -t nat -A POSTROUTING -s "$guest_ip/32"');
    expect(script).toContain("ip route replace default via $controller_ip dev eth0");
    expect(script).toContain("printf 'nameserver 1.1.1.1\\\\noptions single-request-reopen\\\\n'");
    expect(script).toContain("with_hunk=${WITH_HUNK:-0}");
    expect(script).toContain("if [[ $with_hunk == 1 ]]");
    expect(script).toContain(
      'scp -r "${ssh_options[@]}" "$hunk_input/hunk" "$hunk_input/hunkdiff"',
    );
    expect(script).toContain("install -m 0755 /tmp/hunk /usr/local/bin/hunk");
    expect(script).toContain("cp -R /tmp/hunkdiff/skills /usr/local/bin/hunkdiff/skills");
    expect(script).toContain("/usr/local/bin/hunkdiff/skills/hunk-review/SKILL.md");
    expect(script).toContain("/usr/local/bin/hunk --version");
    expect(script).toContain('ip link del "$tap"');
    expect(script).toContain('rm -rf -- "$run_root"');
    expect(script).toContain("rm /root/.ssh/authorized_keys");
    expect(script).toContain("write $run_root/id_ed25519.pub /root/.ssh/authorized_keys");
  });
});
