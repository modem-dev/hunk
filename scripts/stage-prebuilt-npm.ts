#!/usr/bin/env bun

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  binaryFilenameForSpec,
  buildOptionalDependencyMap,
  getHostPlatformPackageSpec,
  getPlatformPackageSpecByName,
  releaseNpmDir,
  sortPlatformPackageSpecs,
  type PlatformPackageSpec,
} from "./prebuilt-package-helpers";

type RootPackageJson = {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  repository?: unknown;
  homepage?: string;
  bugs?: unknown;
  license?: string;
  engines?: Record<string, string>;
};

interface BinaryArtifactMetadata {
  packageName: string;
}

function parseArgs(argv: string[]) {
  let artifactRoot: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--artifact-root") {
      artifactRoot = argv[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    artifactRoot,
  };
}

function loadRootPackage(repoRoot: string) {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as RootPackageJson;
}

function ensureDirectory(directory: string) {
  mkdirSync(directory, { recursive: true });
}

function writeJson(filePath: string, value: unknown) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function stageMetaPackage(
  repoRoot: string,
  rootPackage: RootPackageJson,
  releaseRoot: string,
  specs: readonly PlatformPackageSpec[],
) {
  const metaDir = path.join(releaseRoot, rootPackage.name);
  ensureDirectory(path.join(metaDir, "bin"));
  cpSync(path.join(repoRoot, "bin", "hunk.cjs"), path.join(metaDir, "bin", "hunk.cjs"));
  cpSync(path.join(repoRoot, "README.md"), path.join(metaDir, "README.md"));
  cpSync(path.join(repoRoot, "LICENSE"), path.join(metaDir, "LICENSE"));

  writeJson(path.join(metaDir, "package.json"), {
    name: rootPackage.name,
    version: rootPackage.version,
    description: rootPackage.description,
    bin: {
      hunk: "./bin/hunk.cjs",
    },
    files: ["bin", "README.md", "LICENSE"],
    keywords: rootPackage.keywords,
    repository: rootPackage.repository,
    homepage: rootPackage.homepage,
    bugs: rootPackage.bugs,
    engines: rootPackage.engines,
    optionalDependencies: buildOptionalDependencyMap(rootPackage.version, specs),
    license: rootPackage.license,
    publishConfig: {
      access: "public",
    },
  });
}

function stagePlatformPackage(
  rootPackage: RootPackageJson,
  releaseRoot: string,
  repoRoot: string,
  spec: PlatformPackageSpec,
  compiledBinary: string,
) {
  if (!existsSync(compiledBinary)) {
    throw new Error(`Missing compiled binary at ${compiledBinary}`);
  }

  const packageDir = path.join(releaseRoot, spec.packageName);
  const binaryName = binaryFilenameForSpec(spec);

  ensureDirectory(path.join(packageDir, "bin"));
  const stagedBinary = path.join(packageDir, "bin", binaryName);
  cpSync(compiledBinary, stagedBinary);
  chmodSync(stagedBinary, 0o755);
  cpSync(path.join(repoRoot, "LICENSE"), path.join(packageDir, "LICENSE"));

  writeJson(path.join(packageDir, "package.json"), {
    name: spec.packageName,
    version: rootPackage.version,
    description: `${rootPackage.description} (${spec.os} ${spec.cpu} binary)`,
    os: [spec.os === "windows" ? "win32" : spec.os],
    cpu: [spec.cpu],
    files: ["bin", "LICENSE"],
    license: rootPackage.license,
    publishConfig: {
      access: "public",
    },
  });
}

function collectArtifactSpecs(artifactRoot: string) {
  const directories = readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(artifactRoot, entry.name));

  if (directories.length === 0) {
    throw new Error(`No artifact directories found in ${artifactRoot}`);
  }

  return directories.map((directory) => {
    const metadata = JSON.parse(
      readFileSync(path.join(directory, "metadata.json"), "utf8"),
    ) as BinaryArtifactMetadata;
    const spec = getPlatformPackageSpecByName(metadata.packageName);
    if (!spec) {
      throw new Error(`Unknown platform package in artifact metadata: ${metadata.packageName}`);
    }

    return {
      spec,
      compiledBinary: path.join(directory, binaryFilenameForSpec(spec)),
    };
  });
}

const repoRoot = path.resolve(import.meta.dir, "..");
const options = parseArgs(process.argv.slice(2));
const rootPackage = loadRootPackage(repoRoot);
const releaseRoot = releaseNpmDir(repoRoot);
const artifactRoot = options.artifactRoot ? path.resolve(options.artifactRoot) : undefined;

rmSync(releaseRoot, { recursive: true, force: true });
ensureDirectory(releaseRoot);

const artifacts = artifactRoot
  ? collectArtifactSpecs(artifactRoot)
  : [
      {
        spec: getHostPlatformPackageSpec(),
        compiledBinary: path.join(repoRoot, "dist", "hunk"),
      },
    ];

const stagedSpecs = sortPlatformPackageSpecs(artifacts.map((artifact) => artifact.spec));
stageMetaPackage(repoRoot, rootPackage, releaseRoot, stagedSpecs);

for (const artifact of artifacts) {
  stagePlatformPackage(rootPackage, releaseRoot, repoRoot, artifact.spec, artifact.compiledBinary);
}

console.log(`Staged prebuilt npm packages in ${releaseRoot}`);
console.log(`- ${path.join(releaseRoot, rootPackage.name)}`);
for (const spec of stagedSpecs) {
  console.log(`- ${path.join(releaseRoot, spec.packageName)}`);
}
if (artifactRoot) {
  console.log(`Artifacts source: ${artifactRoot}`);
} else {
  console.log(`Artifacts source: ${path.join(repoRoot, "dist", "hunk")}`);
}
