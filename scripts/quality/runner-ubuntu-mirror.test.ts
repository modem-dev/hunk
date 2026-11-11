import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../.github/scripts/configure-ubuntu-apt-mirror.sh");
const defaultMirrors = [
  "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1",
  "https://archive.ubuntu.com/ubuntu/\tpriority:2",
  "https://security.ubuntu.com/ubuntu/\tpriority:3",
  "",
].join("\n");
const expectedMirrors = `${defaultMirrors}https://mirrors.edge.kernel.org/ubuntu/\tpriority:4\n`;
const roots: string[] = [];

/** Model both hosted-runner deb822 stanzas without touching the host's apt files. */
function createTestAptFixture(suite = "noble") {
  const root = mkdtempSync(join(tmpdir(), "hunk-apt-mirror-"));
  roots.push(root);
  mkdirSync(join(root, "sources.list.d"));
  mkdirSync(join(root, "apt.conf.d"));
  const sourcePath = join(root, "sources.list.d", "ubuntu.sources");
  const source = [
    "# Ubuntu archive",
    "Types: deb",
    "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
    `Suites: ${suite} ${suite}-updates ${suite}-backports`,
    "Components: main restricted universe multiverse",
    "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
    "",
    "# Ubuntu security",
    "Types: deb",
    "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
    `Suites: ${suite}-security`,
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
      test(`keeps ${suite} official mirrors preferred and both source stanzas unchanged`, () => {
        const fixture = createTestAptFixture(suite);
        expect(runTestBootstrap(fixture.root).status).toBe(0);

        expect(readFileSync(fixture.sourcePath, "utf8")).toBe(fixture.source);
        expect(readFileSync(join(fixture.root, "apt-mirrors.txt"), "utf8")).toBe(expectedMirrors);
        expect(readFileSync(join(fixture.root, "apt.conf.d", "zzz-hunk-ci"), "utf8")).toBe(
          'Acquire::Retries "1";\nAcquire::http::Timeout "20";\nAcquire::https::Timeout "20";\nAPT::Update::Error-Mode "any";\n',
        );
        expect(readFileSync(join(fixture.root, "apt.conf.d", "zz-retries"), "utf8")).toBe(
          'Acquire::Retries "1";\n',
        );
        expect(runTestBootstrap(fixture.root).status).toBe(0);
        expect(readFileSync(join(fixture.root, "apt-mirrors.txt"), "utf8")).toBe(expectedMirrors);
        expect(readFileSync(fixture.sourcePath, "utf8")).toBe(fixture.source);
      });
    }

    for (const [name, replacement] of [
      ["unexpected source URI", "URIs: https://archive.ubuntu.com/ubuntu/"],
      [
        "additional source URI",
        "URIs: mirror+file:/etc/apt/apt-mirrors.txt https://example.invalid/",
      ],
      [
        "continued source URI",
        "URIs: mirror+file:/etc/apt/apt-mirrors.txt\n https://example.invalid/",
      ],
      [
        "tab-continued source URI",
        "URIs: mirror+file:/etc/apt/apt-mirrors.txt\n\thttps://example.invalid/",
      ],
      ["missing source URI", "# no URI"],
    ]) {
      test(`refuses ${name} in the security stanza before mutating configuration`, () => {
        const fixture = createTestAptFixture();
        const source = fixture.source.replace(
          "# Ubuntu security\nTypes: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt",
          `# Ubuntu security\nTypes: deb\n${replacement}`,
        );
        writeFileSync(fixture.sourcePath, source);
        const result = runTestBootstrap(fixture.root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "unexpected Ubuntu source URI or archive trust configuration",
        );
        expect(readFileSync(fixture.sourcePath, "utf8")).toBe(source);
        expect(readFileSync(join(fixture.root, "apt-mirrors.txt"), "utf8")).toBe(defaultMirrors);
        expect(() => readFileSync(join(fixture.root, "apt.conf.d", "zzz-hunk-ci"))).toThrow();
      });
    }

    for (const [name, mirrors] of [
      [
        "unexpected mirror without a final newline",
        `${defaultMirrors}https://example.invalid/ubuntu/`,
      ],
      ["missing official mirrors", "https://mirrors.edge.kernel.org/ubuntu/\tpriority:4\n"],
      [
        "fallback preferred over official mirrors",
        `${defaultMirrors}https://mirrors.edge.kernel.org/ubuntu/\tpriority:0\n`,
      ],
      [
        "equal official and fallback priorities",
        `${defaultMirrors}https://mirrors.edge.kernel.org/ubuntu/\tpriority:3\n`,
      ],
      [
        "unspecified fallback priority",
        `${defaultMirrors}https://mirrors.edge.kernel.org/ubuntu/\n`,
      ],
      ["empty mirror list", "# no mirrors\n"],
    ]) {
      test(`refuses ${name} without overwriting the mirror list`, () => {
        const fixture = createTestAptFixture();
        writeFileSync(join(fixture.root, "apt-mirrors.txt"), mirrors!);
        const result = runTestBootstrap(fixture.root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("unexpected Ubuntu mirror list or priorities");
        expect(readFileSync(join(fixture.root, "apt-mirrors.txt"), "utf8")).toBe(mirrors!);
        expect(() => readFileSync(join(fixture.root, "apt.conf.d", "zzz-hunk-ci"))).toThrow();
      });
    }

    for (const [name, replacement] of [
      ["missing keyring", "# missing keyring"],
      [
        "continued keyring",
        "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n /tmp/other-key.gpg",
      ],
      [
        "disabled freshness",
        "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\nCheck-Valid-Until: no",
      ],
      [
        "continued freshness override",
        "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\nCheck-Valid-Until: yes\n no",
      ],
      ["trusted source", "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\nTrusted: yes"],
    ]) {
      test(`refuses ${name} in a source stanza`, () => {
        const fixture = createTestAptFixture();
        writeFileSync(fixture.sourcePath, fixture.source.replace(/^Signed-By:.*$/m, replacement!));

        expect(runTestBootstrap(fixture.root).status).toBe(1);
        expect(readFileSync(join(fixture.root, "apt-mirrors.txt"), "utf8")).toBe(defaultMirrors);
      });
    }

    test("refuses missing runner configuration", () => {
      const fixture = createTestAptFixture();
      rmSync(fixture.sourcePath);
      expect(runTestBootstrap(fixture.root).stderr).toContain("missing runner apt configuration");
      expect(() => readFileSync(join(fixture.root, "apt.conf.d", "zzz-hunk-ci"))).toThrow();
    });
  },
);

const aptHelper = "/usr/lib/apt/apt-helper";

// Use real APT on Ubuntu CI (or in an Ubuntu container), never host source/state directories.
describe.skipIf(process.platform !== "linux" || process.arch !== "x64" || !existsSync(aptHelper))(
  "native APT mirror transport",
  () => {
    for (const success of [1, 2, 4, 0]) {
      test(`tries explicit priorities until ${success ? `mirror ${success} succeeds` : "every mirror fails"}`, async () => {
        const fixture = createTestAptFixture();
        expect(runTestBootstrap(fixture.root).status).toBe(0);
        const requested: number[] = [];
        const payload = "hash-verified native APT transport fixture\n";
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            const index = Number(
              /^\/mirror-(\d)\/payload$/.exec(new URL(request.url).pathname)?.[1],
            );
            requested.push(index);
            return index === success
              ? new Response(payload)
              : new Response("mirror unavailable", { status: 503 });
          },
        });

        try {
          // Substitute loopback endpoints but retain the helper's actual priority metadata.
          // Reverse physical order: success must follow priority, not placement in the file.
          const entries = readFileSync(join(fixture.root, "apt-mirrors.txt"), "utf8")
            .trimEnd()
            .split("\n")
            .map((line, index) => {
              const [, metadata] = line.split("\t");
              return `http://127.0.0.1:${server.port}/mirror-${index + 1}/\t${metadata}`;
            })
            .reverse();
          const list = join(fixture.root, "transport-mirrors.txt");
          writeFileSync(list, `${entries.join("\n")}\n`);
          const uri = `mirror+file:${list}/`;
          const sources = join(fixture.root, "transport.list");
          writeFileSync(sources, `deb ${uri} ./\n`);
          const output = join(fixture.root, "payload");
          const hash = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
          const child = Bun.spawn(
            [
              aptHelper,
              "-o",
              `Dir::Etc::sourcelist=${sources}`,
              "-o",
              "Dir::Etc::sourceparts=-",
              "-o",
              `Dir::State=${fixture.root}`,
              "-o",
              `Dir::Cache=${fixture.root}`,
              "-o",
              "Acquire::Retries=0",
              "-o",
              "Acquire::http::Timeout=2",
              "download-file",
              `${uri}payload`,
              output,
              `SHA256:${hash}`,
            ],
            { stdout: "pipe", stderr: "pipe", timeout: 10_000 },
          );
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);

          expect({ code, diagnostic: code === (success ? 0 : 100) ? "" : stdout + stderr }).toEqual(
            {
              code: success ? 0 : 100,
              diagnostic: "",
            },
          );
          expect(requested).toEqual(Array.from({ length: success || 4 }, (_, index) => index + 1));
          if (success) expect(readFileSync(output, "utf8")).toBe(payload);
        } finally {
          server.stop(true);
        }
      }, 15_000);
    }
  },
);
