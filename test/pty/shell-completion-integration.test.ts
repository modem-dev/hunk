/** Exercise generated completions through real Bash Readline and Zsh ZLE Tab presses. */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_REFERENCE_COMMANDS,
  COMMON_REVIEW_OPTIONS,
  WATCH_OPTION,
} from "../../packages/hunk/src/app/cli";
import {
  renderShellCompletion,
  type CompletionShell,
} from "../../packages/hunk/src/app/shellCompletion";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const roots: string[] = [];
const bashExecutable = process.env.HUNK_TEST_BASH_EXECUTABLE ?? Bun.which("bash");
const reference = {
  commands: CLI_REFERENCE_COMMANDS,
  commonReviewOptions: COMMON_REVIEW_OPTIONS,
  watchOption: WATCH_OPTION,
};
const bashCompletion = [
  process.env.HUNK_TEST_BASH_COMPLETION,
  "/usr/share/bash-completion/bash_completion",
  "/opt/homebrew/etc/profile.d/bash_completion.sh",
  "/usr/local/etc/profile.d/bash_completion.sh",
].find((path) => path && existsSync(path));
setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

/** Quote shell literals, including temporary paths with spaces. */
function quoteTestShell(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Launch an isolated shell whose fixture Hunk function only records completed arguments. */
async function createTestCompletionShell(
  shell: CompletionShell,
  loading: "standalone" | "helper" | "autoload",
) {
  const root = mkdtempSync(join(tmpdir(), "hunk shell completions-"));
  roots.push(root);
  const script = join(root, shell === "bash" ? "hunk.bash" : "_hunk");
  const captured = join(root, "arguments.bin");
  const ready = join(root, "ready");
  writeFileSync(script, renderShellCompletion(shell, reference));
  writeFileSync(join(root, "--mode-decoy"), "");
  writeFileSync(join(root, "example-file.txt"), "");
  writeFileSync(join(root, "session data"), "");

  let command: string;
  if (shell === "bash") {
    const startup = join(root, "bashrc");
    writeFileSync(
      startup,
      [
        loading === "helper"
          ? `source ${quoteTestShell(bashCompletion!)}`
          : "unset -f _get_comp_words_by_ref",
        `source ${quoteTestShell(script)}`,
        `hunk() { printf '%s\\0' "$@" > ${quoteTestShell(captured)}; }`,
        "PS1='HUNK_COMPLETION_READY> '",
        `printf ready > ${quoteTestShell(ready)}`,
      ].join("\n"),
    );
    command = `exec ${quoteTestShell(bashExecutable!)} --noprofile --rcfile ${quoteTestShell(startup)} -i`;
  } else {
    writeFileSync(
      join(root, ".zshrc"),
      [
        "autoload -Uz compinit; compinit -D",
        loading === "autoload"
          ? `fpath=(${quoteTestShell(root)} $fpath); autoload -Uz _hunk; compdef _hunk hunk`
          : `source ${quoteTestShell(script)}`,
        `hunk() { printf '%s\\0' "$@" > ${quoteTestShell(captured)}; }`,
        "PROMPT='HUNK_COMPLETION_READY> '",
        `printf ready > ${quoteTestShell(ready)}`,
      ].join("\n"),
    );
    command = `exec ${quoteTestShell(Bun.which("zsh")!)} -d -i`;
  }

  const session = await harness.launchShellCommand({
    command,
    cwd: root,
    env: { ZDOTDIR: root },
    cols: 160,
    rows: 12,
  });
  await harness.waitForSnapshot(
    session,
    (text) => existsSync(ready) && text.includes("HUNK_COMPLETION_READY>"),
  );

  /** Complete a command and submit it only to the harmless fixture function, including on Bash 3.2. */
  const complete = async (input: string) => {
    rmSync(captured, { force: true });
    session.writeRaw(input);
    await session.press("tab");
    await session.press("enter");
    await harness.waitForSnapshot(session, () => existsSync(captured));
    await session.waitIdle();
    const args = readFileSync(captured, "utf8").split("\0").slice(0, -1);
    return ["hunk", ...args.map((arg) => (/\s/.test(arg) ? quoteTestShell(arg) : arg))].join(" ");
  };

  return { session, complete };
}

for (const [shell, loading] of [
  ["bash", "standalone"],
  ["bash", "helper"],
  ["zsh", "standalone"],
  ["zsh", "autoload"],
] as const) {
  test.skipIf(
    process.platform === "win32" ||
      (shell === "bash" ? bashExecutable === null : Bun.which(shell) === null) ||
      (loading === "helper" && !bashCompletion),
  )(
    `${shell} ${loading} completes real command lines without losing argument boundaries`,
    async () => {
      const { session, complete } = await createTestCompletionShell(shell, loading);
      try {
        if (shell === "bash") {
          for (const input of ["hunk --extension== ", "hunk --extension=prefix:: "]) {
            await session.press(["ctrl", "l"]);
            session.writeRaw(input);
            await session.press("tab");
            await session.press("tab");
            await session.waitForText("difftool");
            await session.press(["ctrl", "c"]);
            await session.waitIdle();
          }
        }

        expect(await complete("hunk se")).toBe("hunk session");
        expect(await complete("hunk session comment ap")).toBe("hunk session comment apply");
        expect(await complete("hunk diff --mo")).toBe("hunk diff --mode");
        expect(await complete("hunk diff --mode sp")).toBe("hunk diff --mode split");
        expect(await complete("hunk --extension=session diff --mo")).toBe(
          "hunk --extension=session diff --mode",
        );
        expect(await complete("hunk --disable-extension=session diff --mo")).toBe(
          "hunk --disable-extension=session diff --mode",
        );
        expect(await complete("hunk --extension 'session data' diff --mo")).toBe(
          "hunk --extension 'session data' diff --mode",
        );
        expect(await complete("hunk --extension=prefix:session diff --mo")).toBe(
          "hunk --extension=prefix:session diff --mode",
        );
        expect(await complete("hunk --extension=prefix::session diff --mo")).toBe(
          "hunk --extension=prefix::session diff --mode",
        );
        expect(await complete("hunk --extension==session diff --mo")).toBe(
          "hunk --extension==session diff --mode",
        );
        expect(await complete("hunk --extension 'éé session' diff --mo")).toBe(
          "hunk --extension 'éé session' diff --mode",
        );
        expect(await complete("hunk session reload test -- diff --mo")).toBe(
          "hunk session reload test -- diff --mode",
        );
        expect(await complete("hunk session reload test -- diff --mode sp")).toBe(
          "hunk session reload test -- diff --mode split",
        );
        expect(await complete("hunk session reload test -- diff -- --mo")).toBe(
          "hunk session reload test -- diff -- --mode-decoy",
        );
        expect(await complete("hunk --fast --mo")).toBe("hunk --fast --mode");
        expect(await complete("hunk --fast --mode sp")).toBe("hunk --fast --mode split");
        expect(await complete("hunk --fast show --cu")).toBe("hunk --fast show --cursor-line");
        expect(await complete("hunk diff -- --mo")).toBe("hunk diff -- --mode-decoy");
        expect(await complete("hunk diff exam")).toBe("hunk diff example-file.txt");
        expect(await complete("hunk --extension exam")).toBe("hunk --extension example-file.txt");
        expect(await complete("hunk diff --he")).toBe("hunk diff --help");
      } finally {
        session.close();
      }
    },
  );
}
