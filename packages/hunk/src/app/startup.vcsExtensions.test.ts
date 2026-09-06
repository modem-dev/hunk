import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareStartupPlan } from "./startup";
import { resolveConfiguredCliInput } from "../core/run/config";
import type { CliInput, ParsedCliInput } from "../core/run/commandInputs";

const tempDirs: string[] = [];
const initialCwd = process.cwd();

afterEach(() => {
  process.chdir(initialCwd);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

describe("external VCS startup bootstrap", () => {
  test("a CLI extension establishes a pure external-VCS project root before loading", async () => {
    const repo = createTempDir("hunk-external-vcs-startup-");
    const nested = join(repo, "src", "nested");
    mkdirSync(join(repo, ".custom"));
    mkdirSync(nested, { recursive: true });
    const extensionPath = join(repo, "custom-vcs.ts");
    const factoryLogPath = join(repo, "factory.log");
    writeFileSync(
      extensionPath,
      `
        import { dirname, join } from "node:path";
        import { appendFileSync, existsSync } from "node:fs";
        export default function (hunk) {
          appendFileSync(${JSON.stringify(factoryLogPath)}, "factory\\n");
          hunk.registerVcsAdapter({
            id: "custom",
            name: "Custom VCS",
            detect(cwd) {
              let current = cwd;
              for (;;) {
                if (existsSync(join(current, ".custom"))) {
                  return { id: "custom", repoRoot: current };
                }
                const parent = dirname(current);
                if (parent === current) return null;
                current = parent;
              }
            },
            operations: {
              "working-tree-diff": {
                async load() {
                  return {
                    repoRoot: ${JSON.stringify(repo)},
                    sourceLabel: ${JSON.stringify(repo)},
                    title: "Custom working copy",
                    patchText: "",
                  };
                },
              },
            },
          });
        }
      `,
    );
    process.chdir(nested);
    const input: CliInput = {
      kind: "vcs",
      staged: false,
      options: { extensionPaths: [extensionPath] },
    };

    const resolvedProjectRoots: Array<string | undefined> = [];
    const plan = await prepareStartupPlan(["bun", "hunk", "diff"], {
      parseCliImpl: async () => input as ParsedCliInput,
      resolveRuntimeCliInputImpl: (value) => value,
      resolveConfiguredCliInputImpl: (value, options) => {
        const result = resolveConfiguredCliInput(value, options);
        resolvedProjectRoots.push(result.projectRoot);
        return result;
      },
      stdinIsTTY: true,
      stdoutIsTTY: false,
      env: { HOME: createTempDir("hunk-external-vcs-home-") },
    });

    expect(plan.kind).toBe("app");
    if (plan.kind !== "app") {
      return;
    }
    expect(resolvedProjectRoots).toEqual([undefined, repo]);
    expect(plan.bootstrap.reloadContext.repoRoot).toBe(repo);
    expect(plan.bootstrap.input.options.vcs).toBe("custom");
    expect(plan.bootstrap.changeset.title).toBe("Custom working copy");
    expect(readFileSync(factoryLogPath, "utf8")).toBe("factory\n");
  });
});
