import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
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
  prepareVmShellInput,
  removeVmShellInput,
  runWithVmShellRuntime,
  stageVmShellInput,
  validateVmShellTty,
  VM_SHELL_EXAMPLE_FILES,
} from "./vm-shell";

const harnessRoot = import.meta.dir;
const repoRoot = path.resolve(harnessRoot, "../../..");

/** Create a small patch for tests that exercise staging rather than parser scale. */
function createTestBenchmarkPatch() {
  return "diff --git a/example.ts b/example.ts\n@@ -1 +1 @@\n-old\n+new\n";
}

/** Create the allowlisted example files expected by shell-input staging tests. */
function writeTestVmShellExamples(repo: string) {
  for (const relativePath of VM_SHELL_EXAMPLE_FILES) {
    const destination = path.join(repo, "examples", relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, `example ${relativePath}\n`);
  }
}

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

  test("builds an interactive least-privilege Docker invocation with curated shell input", () => {
    const command = buildDockerVmShellCommand(
      "hunk-install-vm:test",
      "/safe/cache",
      { uid: 1000, gid: 1000 },
      { shellInputDir: "/safe/shell-input", withHunk: false },
    );
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
    expect(command).toContain("--mount=type=bind,src=/safe/shell-input,dst=/shell-input,readonly");
    expect(command).toContain("--entrypoint=/opt/install-vm/vm-shell-controller.sh");
    expect(command.filter((argument) => argument.startsWith("--mount="))).toHaveLength(2);
    expect(command.join(" ")).not.toContain("docker.sock");
    expect(command.join(" ")).not.toContain("/repo");
    expect(command.join(" ")).not.toContain("/fixtures");
    expect(command.join(" ")).not.toContain("/artifacts");
    expect(command.join(" ")).not.toContain("INSTALL_VM_SCENARIOS");
    expect(command.join(" ")).not.toContain("WITH_HUNK");

    const withHunk = buildDockerVmShellCommand(
      "hunk-install-vm:test",
      "/safe/cache",
      { uid: 1000, gid: 1000 },
      { shellInputDir: "/safe/shell-input", withHunk: true },
    );
    expect(withHunk).toContain("--env=WITH_HUNK=1");
    expect(withHunk).toContain("--mount=type=bind,src=/safe/shell-input,dst=/shell-input,readonly");
    expect(withHunk.filter((argument) => argument.startsWith("--mount="))).toHaveLength(2);
    expect(() =>
      buildDockerVmShellCommand(
        "image",
        "/unsafe,cache",
        { uid: 1, gid: 1 },
        { shellInputDir: "/safe/input", withHunk: false },
      ),
    ).toThrow("Unsafe Docker bind path");
    expect(() =>
      buildDockerVmShellCommand(
        "image",
        "/safe/cache",
        { uid: 1, gid: 1 },
        { shellInputDir: "/unsafe,input", withHunk: false },
      ),
    ).toThrow("Unsafe Docker bind path");
  });

  test("stages only curated examples and deterministic benchmark patches by default", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "hunk-vm-shell-stage-"));
    const outside = mkdtempSync(path.join(tmpdir(), "hunk-vm-shell-outside-"));
    try {
      const runtime = path.join(repo, "tmp", "install-vm");
      const staging = path.join(runtime, "vm-shell-input");
      writeTestVmShellExamples(repo);
      mkdirSync(runtime, { recursive: true });
      symlinkSync(outside, path.join(repo, "examples", "2-mini-app-refactor", "not-staged"));

      expect(stageVmShellInput(repo, staging, { withHunk: false }, createTestBenchmarkPatch)).toBe(
        staging,
      );
      for (const relativePath of VM_SHELL_EXAMPLE_FILES) {
        expect(readFileSync(path.join(staging, "fixtures", "examples", relativePath), "utf8")).toBe(
          `example ${relativePath}\n`,
        );
      }
      expect(readFileSync(path.join(staging, "fixtures", "README.md"), "utf8")).toContain(
        "hunk patch fixtures/benchmarks/balanced-changeset.patch",
      );
      for (const name of [
        "many-small-files.patch",
        "balanced-changeset.patch",
        "large-single-file.patch",
      ]) {
        expect(readFileSync(path.join(staging, "fixtures", "benchmarks", name), "utf8")).toContain(
          "@@",
        );
      }
      expect(existsSync(path.join(staging, "hunk"))).toBe(false);

      removeVmShellInput(repo, staging);
      expect(existsSync(staging)).toBe(false);
      const selectedSource = path.join(repo, "examples", "2-mini-app-refactor", "change.patch");
      rmSync(selectedSource);
      symlinkSync(outside, selectedSource);
      expect(() => stageVmShellInput(repo, staging, { withHunk: false })).toThrow(
        "may not be a symlink",
      );
      rmSync(selectedSource);
      writeFileSync(selectedSource, "restored example\n");
      symlinkSync(outside, staging);
      expect(() => stageVmShellInput(repo, staging, { withHunk: false })).toThrow(
        "symlink ancestor",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("keeps every allowlisted real example usable as a review input", () => {
    for (const relativePath of VM_SHELL_EXAMPLE_FILES) {
      const contents = readFileSync(path.join(repoRoot, "examples", relativePath), "utf8");
      expect(contents.length).toBeGreaterThan(0);
      if (relativePath.endsWith(".patch")) {
        expect(
          parsePatchFiles(contents, relativePath, true).flatMap((entry) => entry.files).length,
        ).toBeGreaterThan(0);
      }
      if (relativePath.endsWith(".json")) expect(() => JSON.parse(contents)).not.toThrow();
    }
  });

  test("runs a fresh host build before adding Hunk to the staged shell input", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "hunk-vm-shell-build-"));
    try {
      const runtime = path.join(repo, "tmp", "install-vm");
      const staging = path.join(runtime, "vm-shell-input");
      mkdirSync(staging, { recursive: true });
      writeFileSync(path.join(staging, "hunk"), "stale staged binary\n");
      writeTestVmShellExamples(repo);
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

      await prepareVmShellInput(
        repo,
        staging,
        { withHunk: true },
        runner,
        "/test/bun",
        createTestBenchmarkPatch,
      );
      expect(command).toEqual(["/test/bun", "run", "build:bin"]);
      expect(cwd).toBe(repo);
      expect(readFileSync(path.join(staging, "hunk"), "utf8")).toBe("fresh build\n");
      expect(
        readFileSync(path.join(staging, "hunkdiff", "skills", "hunk-review", "SKILL.md"), "utf8"),
      ).toBe("skill\n");
      if (process.platform !== "win32") {
        expect(statSync(path.join(staging, "hunk")).mode & 0o777).toBe(0o755);
      }
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
    expect(script).toContain("shell_input=/shell-input");
    expect(script).toContain('scp -r "${ssh_options[@]}" "$shell_input/fixtures"');
    expect(script).toContain("install -d -m 0700 /root/fixtures");
    expect(script).toContain("/root/fixtures/benchmarks/balanced-changeset.patch");
    expect(script).toContain("Fixtures are available under /root/fixtures");
    expect(script).toContain("if [[ $with_hunk == 1 ]]");
    expect(script).toContain(
      'scp -r "${ssh_options[@]}" "$shell_input/hunk" "$shell_input/hunkdiff"',
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
