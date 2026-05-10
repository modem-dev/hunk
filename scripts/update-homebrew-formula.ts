#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const FORMULA_RELATIVE_PATH = path.join("Formula", "hunk.rb");
const RELEASE_ASSET_NAMES = {
  darwinArm64: "hunkdiff-darwin-arm64.tar.gz",
  darwinX64: "hunkdiff-darwin-x64.tar.gz",
  linuxArm64: "hunkdiff-linux-arm64.tar.gz",
  linuxX64: "hunkdiff-linux-x64.tar.gz",
} as const;

interface Options {
  assetRoot: string;
  outputRoot: string;
  repo: string;
  tag: string;
}

function parseArgs(argv: string[]): Options {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const options: Options = {
    assetRoot: path.join(repoRoot, "dist", "release", "github"),
    outputRoot: repoRoot,
    repo: "modem-dev/hunk",
    tag: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];

    if (argument === "--asset-root") {
      if (!value) {
        throw new Error("Missing value for --asset-root.");
      }
      options.assetRoot = path.resolve(value);
      index += 1;
      continue;
    }

    if (argument === "--output-root") {
      if (!value) {
        throw new Error("Missing value for --output-root.");
      }
      options.outputRoot = path.resolve(value);
      index += 1;
      continue;
    }

    if (argument === "--repo") {
      if (!value) {
        throw new Error("Missing value for --repo.");
      }
      options.repo = value;
      index += 1;
      continue;
    }

    if (argument === "--tag") {
      if (!value) {
        throw new Error("Missing value for --tag.");
      }
      options.tag = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!options.tag) {
    throw new Error("Missing required --tag vX.Y.Z argument.");
  }

  return options;
}

function versionFromTag(tag: string) {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Homebrew formula updates only support stable semver tags, got ${tag}.`);
  }

  return version;
}

function sha256(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function assetUrl(repo: string, tag: string, assetName: string) {
  return `https://github.com/${repo}/releases/download/${tag}/${assetName}`;
}

function formulaContent(options: Options) {
  const version = versionFromTag(options.tag);
  const checksums = Object.fromEntries(
    Object.entries(RELEASE_ASSET_NAMES).map(([key, assetName]) => {
      const assetPath = path.join(options.assetRoot, assetName);
      if (!existsSync(assetPath)) {
        const found = existsSync(options.assetRoot)
          ? readdirSync(options.assetRoot).join(", ")
          : "";
        throw new Error(`Missing release asset ${assetPath}. Found: ${found}`);
      }

      return [key, sha256(assetPath)];
    }),
  ) as Record<keyof typeof RELEASE_ASSET_NAMES, string>;

  return `class Hunk < Formula
  desc "Desktop-inspired terminal diff viewer for agent-authored changesets"
  homepage "https://github.com/modem-dev/hunk"
  version "${version}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "${assetUrl(options.repo, options.tag, RELEASE_ASSET_NAMES.darwinArm64)}"
      sha256 "${checksums.darwinArm64}"
    else
      url "${assetUrl(options.repo, options.tag, RELEASE_ASSET_NAMES.darwinX64)}"
      sha256 "${checksums.darwinX64}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "${assetUrl(options.repo, options.tag, RELEASE_ASSET_NAMES.linuxArm64)}"
      sha256 "${checksums.linuxArm64}"
    else
      url "${assetUrl(options.repo, options.tag, RELEASE_ASSET_NAMES.linuxX64)}"
      sha256 "${checksums.linuxX64}"
    end
  end

  def install
    chmod 0755, "hunk"
    libexec.install "hunk"
    (bin/"hunk").write_env_script libexec/"hunk", HUNK_INSTALL_SOURCE: "homebrew"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/hunk --version")
  end
end
`;
}

const options = parseArgs(process.argv.slice(2));
const formulaPath = path.join(options.outputRoot, FORMULA_RELATIVE_PATH);
mkdirSync(path.dirname(formulaPath), { recursive: true });
writeFileSync(formulaPath, formulaContent(options));
console.log(`Updated ${formulaPath}`);
