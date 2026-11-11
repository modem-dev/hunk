import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../.github/scripts/configure-ubuntu-apt-mirror.sh");
const mirror = "https://mirrors.edge.kernel.org/ubuntu/\n";
const defaultMirrors = [
  "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1",
  "https://archive.ubuntu.com/ubuntu/\tpriority:2",
  "https://security.ubuntu.com/ubuntu/\tpriority:3",
  "",
].join("\n");
const roots: string[] = [];

/** Model the hosted runner's deb822 configuration without touching the host's apt files. */
function createTestAptFixture(suite = "noble") {
  const root = mkdtempSync(join(tmpdir(), "hunk-apt-mirror-"));
  roots.push(root);
  mkdirSync(join(root, "sources.list.d"));
  mkdirSync(join(root, "apt.conf.d"));
  const sourcePath = join(root, "sources.list.d", "ubuntu.sources");
  const source = [
    "Types: deb",
    "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
    `Suites: ${suite} ${suite}-updates ${suite}-backports ${suite}-security`,
    "Components: main restricted universe multiverse",
    "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
    "",
  ].join("\n");
  writeFileSync(sourcePath, source);
  writeFileSync(join(root, "apt-mirrors.txt"), defaultMirrors);
  writeFileSync(join(root, "apt.conf.d", "zz-retries"), 'Acquire::Retries "1";\n');
  return { root, source, sourcePath };
}

/** Run the real bootstrap with no network requests or elevated privileges. */
function runTestBootstrap(root: string) {
  return spawnSync("bash", [script, root], { encoding: "utf8", timeout: 5000 });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// This bootstrap intentionally supports only the Linux x64 hosted jobs that invoke it.
describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "Ubuntu runner mirror",
  () => {
    for (const suite of ["noble", "resolute"]) {
      test(`routes ${suite} through the independent mirror without changing archive trust or suites`, () => {
        const fixture = createTestAptFixture(suite);
        const result = runTestBootstrap(fixture.root);

        expect(result.status).toBe(0);
        expect(readFileSync(fixture.sourcePath, "utf8")).toBe(fixture.source);
        expect(readFileSync(join(fixture.root, "apt-mirrors.txt"), "utf8")).toBe(mirror);
        expect(readFileSync(join(fixture.root, "apt.conf.d", "zzz-hunk-ci"), "utf8")).toBe(
          'Acquire::Retries "1";\nAcquire::http::Timeout "20";\nAcquire::https::Timeout "20";\nAPT::Update::Error-Mode "any";\n',
        );
        expect(readFileSync(join(fixture.root, "apt.conf.d", "zz-retries"), "utf8")).toBe(
          'Acquire::Retries "1";\n',
        );
        expect(runTestBootstrap(fixture.root).status).toBe(0);
      });
    }

    for (const [name, replacement] of [
      ["unexpected source URI", "URIs: https://archive.ubuntu.com/ubuntu/"],
      [
        "additional source URI",
        "URIs: mirror+file:/etc/apt/apt-mirrors.txt https://example.invalid/",
      ],
      ["missing source URI", "# no URI"],
    ]) {
      test(`refuses ${name} before mutating apt configuration`, () => {
        const fixture = createTestAptFixture();
        const source = fixture.source.replace(
          "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
          replacement!,
        );
        writeFileSync(fixture.sourcePath, source);
        const result = runTestBootstrap(fixture.root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("unexpected Ubuntu source URI");
        expect(readFileSync(fixture.sourcePath, "utf8")).toBe(source);
        expect(readFileSync(join(fixture.root, "apt-mirrors.txt"), "utf8")).toBe(defaultMirrors);
        expect(() => readFileSync(join(fixture.root, "apt.conf.d", "zzz-hunk-ci"))).toThrow();
      });
    }

    test("refuses an unexpected mirror without overwriting it", () => {
      const fixture = createTestAptFixture();
      // An unterminated last line must not evade validation after otherwise valid entries.
      const unexpected = `${defaultMirrors}https://example.invalid/ubuntu/`;
      writeFileSync(join(fixture.root, "apt-mirrors.txt"), unexpected);
      const result = runTestBootstrap(fixture.root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unexpected mirror");
      expect(readFileSync(join(fixture.root, "apt-mirrors.txt"), "utf8")).toBe(unexpected);
      expect(() => readFileSync(join(fixture.root, "apt.conf.d", "zzz-hunk-ci"))).toThrow();
    });

    test("refuses a missing archive keyring declaration", () => {
      const fixture = createTestAptFixture();
      writeFileSync(fixture.sourcePath, fixture.source.replace(/^Signed-By:.*\n/m, ""));
      const result = runTestBootstrap(fixture.root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("missing Ubuntu archive keyring");
      expect(readFileSync(join(fixture.root, "apt-mirrors.txt"), "utf8")).toBe(defaultMirrors);
    });

    test("refuses a missing runner configuration and an empty mirror list", () => {
      const fixture = createTestAptFixture();
      rmSync(fixture.sourcePath);
      expect(runTestBootstrap(fixture.root).stderr).toContain("missing runner apt configuration");

      writeFileSync(fixture.sourcePath, fixture.source);
      writeFileSync(join(fixture.root, "apt-mirrors.txt"), "# no mirrors\n");
      expect(runTestBootstrap(fixture.root).stderr).toContain("empty Ubuntu mirror list");
      expect(() => readFileSync(join(fixture.root, "apt.conf.d", "zzz-hunk-ci"))).toThrow();
    });
  },
);
