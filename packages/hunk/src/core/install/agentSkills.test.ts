import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readBundledSkillDocument } from "../run/paths";
import {
  AGENT_SKILL_HOST_IDS,
  AGENT_SKILL_HOSTS,
  AGENT_SKILL_STUB_MARKER,
  parseSkillFrontmatter,
  planAgentSkillTargets,
  renderAgentSkillStub,
  resolveAgentSkillHost,
  runAgentSkillInstallCommand,
  type AgentSkillInstallInput,
} from "./agentSkills";

const HOME = join("/", "home", "reviewer");
const CWD = join("/", "work", "repo");

const REVIEW_SKILL = [
  "---",
  "name: hunk-review",
  "description: Drives a live Hunk session: navigates, comments, reloads.",
  "---",
  "",
  "# Full instructions that must never be copied",
].join("\n");

/** Run one install against an in-memory tree, returning output and every file written. */
async function runInstall(
  input: Partial<AgentSkillInstallInput>,
  options: { existing?: Record<string, string>; env?: NodeJS.ProcessEnv } = {},
) {
  const stdout: string[] = [];
  const files = new Map(Object.entries(options.existing ?? {}));
  const written: string[] = [];
  let exitCode: number | undefined;
  let error: unknown;
  try {
    exitCode = await runAgentSkillInstallCommand(
      { skill: "hunk-review", agents: ["claude"], scope: "user", force: false, ...input },
      {
        stdout: (text) => stdout.push(text),
        env: options.env ?? { HOME },
        cwd: CWD,
        readBundledSkill: () => REVIEW_SKILL,
        readFile: (path) => files.get(path),
        writeFile: (path, text) => {
          files.set(path, text);
          written.push(path);
        },
      },
    );
  } catch (caught) {
    error = caught;
  }
  return { exitCode, error, stdout: stdout.join(""), files, written };
}

describe("agent skill hosts", () => {
  test("resolves ids and aliases case-insensitively", () => {
    expect(resolveAgentSkillHost("claude")?.id).toBe("claude");
    expect(resolveAgentSkillHost("Claude-Code")?.id).toBe("claude");
    expect(resolveAgentSkillHost(" GitHub-Copilot ")?.id).toBe("copilot");
    expect(resolveAgentSkillHost("aider")).toBeUndefined();
    expect(AGENT_SKILL_HOST_IDS).toEqual(AGENT_SKILL_HOSTS.map((host) => host.id));
  });

  test("honors each agent's home override before falling back to the home directory", () => {
    const context = {
      env: {
        HOME,
        CLAUDE_CONFIG_DIR: join("/", "cfg", "claude"),
        CODEX_HOME: join("/", "cfg", "codex"),
      },
      home: HOME,
      cwd: CWD,
    };
    const targets = planAgentSkillTargets(
      { skill: "hunk-review", agents: ["claude", "codex", "opencode", "cursor"], scope: "user" },
      context,
    );

    expect(targets.map((target) => target.path)).toEqual([
      join("/", "cfg", "claude", "skills", "hunk-review", "SKILL.md"),
      join("/", "cfg", "codex", "skills", "hunk-review", "SKILL.md"),
      join(HOME, ".config", "opencode", "skills", "hunk-review", "SKILL.md"),
      join(HOME, ".cursor", "skills", "hunk-review", "SKILL.md"),
    ]);
  });

  test("routes XDG-style hosts through XDG_CONFIG_HOME like Hunk's own config", () => {
    const xdg = join("/", "xdg");
    const targets = planAgentSkillTargets(
      { skill: "hunk-review", agents: ["opencode", "amp"], scope: "user" },
      { env: { HOME, XDG_CONFIG_HOME: xdg }, home: HOME, cwd: CWD },
    );

    expect(targets.map((target) => target.path)).toEqual([
      join(xdg, "opencode", "skills", "hunk-review", "SKILL.md"),
      join(xdg, "agents", "skills", "hunk-review", "SKILL.md"),
    ]);
  });

  test("writes project-scoped skills under the current directory and dedupes shared directories", () => {
    const targets = planAgentSkillTargets(
      { skill: "hunk-extensions", agents: ["codex", "amp", "agents", "copilot"], scope: "project" },
      { env: { HOME }, home: HOME, cwd: CWD },
    );

    // Codex, Amp, and the generic host all read `.agents/skills`, so that pointer is written once.
    expect(targets.map((target) => [target.host.id, target.path])).toEqual([
      ["codex", join(CWD, ".agents", "skills", "hunk-extensions", "SKILL.md")],
      ["copilot", join(CWD, ".github", "skills", "hunk-extensions", "SKILL.md")],
    ]);
  });
});

describe("pointer skill rendering", () => {
  test("copies name and description from the bundled frontmatter", () => {
    expect(parseSkillFrontmatter(REVIEW_SKILL)).toEqual({
      name: "hunk-review",
      description: "Drives a live Hunk session: navigates, comments, reloads.",
    });
    expect(parseSkillFrontmatter(REVIEW_SKILL.replaceAll("\n", "\r\n"))).toEqual(
      parseSkillFrontmatter(REVIEW_SKILL),
    );
  });

  test("rejects bundled documents without usable frontmatter", () => {
    expect(() => parseSkillFrontmatter("# no frontmatter")).toThrow("missing its frontmatter");
    expect(() => parseSkillFrontmatter("---\nname: x\n---\n")).toThrow(
      "must declare both name and description",
    );
  });

  test("renders a pointer that defers to `hunk skill show` and carries the regeneration marker", () => {
    const stub = renderAgentSkillStub(parseSkillFrontmatter(REVIEW_SKILL));

    expect(stub.startsWith("---\nname: hunk-review\ndescription: Drives a live Hunk session")).toBe(
      true,
    );
    expect(stub).toContain(AGENT_SKILL_STUB_MARKER);
    expect(stub).toContain("hunk skill show hunk-review");
    expect(stub).not.toContain("Full instructions that must never be copied");
  });

  test("parses the real bundled skills so the pointer never ships blank triggers", () => {
    for (const name of ["hunk-review", "hunk-extensions"] as const) {
      const frontmatter = parseSkillFrontmatter(readBundledSkillDocument(name));
      expect(frontmatter.name).toBe(name);
      expect(frontmatter.description.length).toBeGreaterThan(20);
    }
  });
});

describe("runAgentSkillInstallCommand", () => {
  test("writes one pointer per agent and reports each path", async () => {
    const { exitCode, stdout, files, written } = await runInstall({
      agents: ["claude", "cursor"],
    });

    expect(exitCode).toBe(0);
    expect(written).toEqual([
      join(HOME, ".claude", "skills", "hunk-review", "SKILL.md"),
      join(HOME, ".cursor", "skills", "hunk-review", "SKILL.md"),
    ]);
    for (const path of written) {
      expect(files.get(path)).toContain("hunk skill show hunk-review");
    }
    expect(stdout).toContain("Installed hunk-review for Claude Code");
    expect(stdout).toContain("Installed hunk-review for Cursor");
    expect(stdout).toContain("stays current across Hunk upgrades");
  });

  test("overwrites its own earlier pointer without --force", async () => {
    const path = join(HOME, ".claude", "skills", "hunk-review", "SKILL.md");
    const { exitCode, written } = await runInstall(
      {},
      { existing: { [path]: `---\nname: hunk-review\n---\n${AGENT_SKILL_STUB_MARKER}\nold body` } },
    );

    expect(exitCode).toBe(0);
    expect(written).toEqual([path]);
  });

  test("refuses to replace a hand-written skill unless forced, and writes nothing", async () => {
    const claudePath = join(HOME, ".claude", "skills", "hunk-review", "SKILL.md");
    const cursorPath = join(HOME, ".cursor", "skills", "hunk-review", "SKILL.md");
    const existing = { [cursorPath]: "# my own hunk skill" };

    const refused = await runInstall({ agents: ["claude", "cursor"] }, { existing });
    expect(String(refused.error)).toContain("already exists and was not generated by Hunk");
    // The refusal happens before any write, so the Claude pointer is not half-installed.
    expect(refused.written).toEqual([]);

    const forced = await runInstall({ agents: ["claude", "cursor"], force: true }, { existing });
    expect(forced.exitCode).toBe(0);
    expect(forced.written).toEqual([claudePath, cursorPath]);
  });

  test("rejects unknown agents by name", async () => {
    const { error } = await runInstall({
      agents: ["aider" as unknown as AgentSkillInstallInput["agents"][number]],
    });
    expect(String(error)).toContain('Unknown agent "aider"');
  });
});
