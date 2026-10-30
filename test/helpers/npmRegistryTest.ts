import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNpmCommand } from "../../packages/hunk/src/extensions/manage/npmCommand";

/** Start an isolated registry and publish real npm tarballs without public network access. */
export async function createNpmRegistryTest(root: string, options: { authToken?: string } = {}) {
  const packages: Record<
    string,
    {
      versions: Record<string, { manifest: object; tarball: string }>;
      tags: Record<string, string>;
    }
  > = {};
  writeFileSync(join(root, "registry.json"), "{}");
  writeFileSync(join(root, "user.npmrc"), "");
  writeFileSync(join(root, "global.npmrc"), "");
  writeFileSync(join(root, "registry-auth.json"), JSON.stringify(options.authToken ?? null));
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "npmRegistryTestServer.ts"), root],
    { stdout: "pipe", stderr: "inherit" },
  );
  let registry: string;
  try {
    const reader = proc.stdout.getReader();
    try {
      const first = await reader.read();
      registry = new TextDecoder().decode(first.value).trim();
    } finally {
      reader.releaseLock();
    }

    if (!registry.startsWith("http://127.0.0.1:")) throw new Error("Test registry did not start");
  } catch (error) {
    proc.kill();
    await proc.exited;
    throw error;
  }
  let counter = 0;

  /** Publish a package with caller-controlled entry files, dependencies, and tags. */
  function publish(
    name: string,
    version: string,
    options: {
      manifest?: Record<string, unknown>;
      files?: Record<string, string>;
      tag?: string;
    } = {},
  ) {
    const dir = join(root, `package-${counter++}`);
    mkdirSync(dir);
    const manifest = { name, version, hunk: { extensions: ["./entry.js"] }, ...options.manifest };
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    for (const [file, content] of Object.entries(
      options.files ?? { "entry.js": "export default () => {};" },
    )) {
      const path = join(dir, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }

    const pack = Bun.spawnSync(
      [...resolveNpmCommand(), "pack", "--json", "--ignore-scripts", "--pack-destination", root],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    if (pack.exitCode !== 0) throw new Error(pack.stderr?.toString());
    const tarball = JSON.parse(pack.stdout!.toString())[0].filename;
    // Read once here too: a missing tarball fails before the installer starts.
    readFileSync(join(root, tarball));
    const record = (packages[name] ??= { versions: {}, tags: {} });
    record.versions[version] = { manifest, tarball };
    record.tags[options.tag ?? "latest"] = version;
    writeFileSync(join(root, "registry.json"), JSON.stringify(packages));
  }

  return {
    registry,
    publish,
    env: {
      npm_config_registry: registry,
      npm_config_cache: join(root, "cache"),
      npm_config_userconfig: join(root, "user.npmrc"),
      npm_config_globalconfig: join(root, "global.npmrc"),
    },
    /** Stop the server before deleting its fixture directory. */
    async close() {
      proc.kill();
      await proc.exited;
    },
  };
}
