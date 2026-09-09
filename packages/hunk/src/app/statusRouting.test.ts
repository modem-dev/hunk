import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledVcsCatalog } from "./vcsCatalog";
import { loadStatusBootstrap } from "./statusBootstrap";
import { createSessionRegistration } from "./session/registration";
import { ReviewProducer } from "./review/producer";

/** Run shell-free Git fixture commands with explicit author identity. */
function runStatusTestGit(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Status",
      GIT_AUTHOR_EMAIL: "status@example.com",
      GIT_COMMITTER_NAME: "Status",
      GIT_COMMITTER_EMAIL: "status@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode) throw new Error(result.stderr.toString());
}

test("sibling log/diff source facts reach real bootstraps and broker registration without adopting sibling config/extensions", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunk-status-routing-"));
  const cwd = join(root, "origin");
  const sibling = join(root, "sibling");
  const config = join(root, "config");
  mkdirSync(cwd);
  mkdirSync(join(config, "hunk"), { recursive: true });
  writeFileSync(
    join(config, "hunk", "config.toml"),
    'theme = "status-custom"\nline_numbers = false\n\n[themes.status-custom]\nlabel = "Status custom"\naccent = "#123456"\n',
  );
  runStatusTestGit(cwd, ["init", "-qb", "main"]);
  writeFileSync(join(cwd, "alpha.ts"), "export const alpha = 1;\n");
  runStatusTestGit(cwd, ["add", "."]);
  runStatusTestGit(cwd, ["commit", "-qm", "Origin commit"]);
  runStatusTestGit(cwd, ["worktree", "add", "-qb", "sibling", sibling]);
  writeFileSync(join(sibling, "alpha.ts"), "export const alpha = 2;\n");
  mkdirSync(join(sibling, ".hunk", "extensions"), { recursive: true });
  writeFileSync(
    join(sibling, ".hunk", "extensions", "untrusted.ts"),
    'throw new Error("Sibling extension must never load");',
  );
  writeFileSync(join(sibling, ".hunk", "config.toml"), 'theme = "nord"\nline_numbers = true\n');
  const runtime = await loadStatusBootstrap({
    input: {
      kind: "status",
      static: false,
      json: false,
      color: "always",
      options: { vcs: "git", extensions: false, experimental: true, fast: true },
    },
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: config },
    baseVcsCatalog: getBundledVcsCatalog(),
  });
  try {
    const owner = runtime.extensionSession.current;
    const snapshot = await runtime.load(sibling);
    const action = await runtime.planReview(snapshot, "unstaged");
    const bootstrap = await runtime.prepareReview(action.input, action.cwd);
    expect(bootstrap.reloadContext.cwd).toBe(sibling);
    expect(bootstrap.input.options).toMatchObject({
      experimental: true,
      fast: true,
      extensions: false,
      lineNumbers: false,
    });
    expect(bootstrap.initialTheme).toBe("status-custom");
    expect(bootstrap.extensions).toBe(owner);
    expect(bootstrap.changeset.files.some((file) => file.path === "alpha.ts")).toBe(true);
    const producer = new ReviewProducer({
      files: bootstrap.changeset.files,
      sourceLabel: bootstrap.changeset.sourceLabel,
    });
    const registration = createSessionRegistration(
      bootstrap,
      producer.getPublication(),
      action.cwd,
    );
    expect(registration.cwd).toBe(sibling);
    expect(registration.repoRoot).toBe(sibling);
    const history = await runtime.openHistory(sibling);
    try {
      expect(history.extensionSession).toBe(runtime.extensionSession);
      const page = await history.source.read({ limit: 10 });
      expect(page.commits[0]!.subject).toBe("Origin commit");
      const planned = await history.planReview(page.commits[0]!);
      const review = await runtime.prepareHistoryReview(planned, history.repoRoot);
      expect(review.reloadContext.cwd).toBe(sibling);
      expect(review.extensions).toBe(owner);
      expect(review.input.options.experimental).toBe(true);
      expect(review.initialTheme).toBe("status-custom");
    } finally {
      await history.close();
    }
    expect(runtime.extensionSession.cwd).toBe(cwd);
    expect(owner.registry.eventBusPhase).toBe("ready");
  } finally {
    await runtime.close();
    await runtime.extensionSession.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
