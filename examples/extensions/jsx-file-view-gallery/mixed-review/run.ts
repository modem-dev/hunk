import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const galleryRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(import.meta.dir, "../../../..");
const demoRepo = mkdtempSync(join(tmpdir(), "hunk-jsx-mixed-review-"));

interface DemoFile {
  target: string;
  before: string;
  after: string;
}

const files: DemoFile[] = [
  {
    target: "README.md",
    before: join(import.meta.dir, "fixtures/before/README.md"),
    after: join(import.meta.dir, "fixtures/after/README.md"),
  },
  {
    target: "package.json",
    before: join(galleryRoot, "fixtures/package-dependencies/before/package.json"),
    after: join(galleryRoot, "fixtures/package-dependencies/after/package.json"),
  },
  {
    target: "scripts/deploy.py",
    before: join(import.meta.dir, "fixtures/before/scripts/deploy.py"),
    after: join(import.meta.dir, "fixtures/after/scripts/deploy.py"),
  },
  {
    target: "src/invoice.ts",
    before: join(galleryRoot, "fixtures/change-atlas/before.ts"),
    after: join(galleryRoot, "fixtures/change-atlas/after.ts"),
  },
  {
    target: "styles/theme.css",
    before: join(galleryRoot, "fixtures/css-palette/before.css"),
    after: join(galleryRoot, "fixtures/css-palette/after.css"),
  },
];

/** Run Git setup with deterministic local identity and actionable failure output. */
function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: demoRepo, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
}

/** Copy one side of every fixture into the temporary working repository. */
function installSide(side: "before" | "after") {
  for (const file of files) {
    const target = join(demoRepo, file.target);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file[side], target);
  }
}

try {
  installSide("before");
  git("init", "--quiet");
  git("config", "user.name", "Hunk Demo");
  git("config", "user.email", "demo@hunk.local");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", "demo baseline");
  installSide("after");

  console.log("Opening a five-file working-tree review.");
  console.log("Enable previews with F8 on package.json, src/invoice.ts, and styles/theme.css.");
  console.log("README.md and scripts/deploy.py intentionally remain raw diffs.\n");

  const result = spawnSync(
    process.execPath,
    [
      join(repoRoot, "packages/hunk/src/main.tsx"),
      "diff",
      "--extension",
      galleryRoot,
      "--mode",
      "stack",
    ],
    { cwd: demoRepo, stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(demoRepo, { recursive: true, force: true });
}
