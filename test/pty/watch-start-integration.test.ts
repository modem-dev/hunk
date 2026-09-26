import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const acknowledgement = "\x1b]777;hunk-watch-first-key-ack\x07";

/** Build a warm-index checkout without hiding watcher cost behind a large dirty diff. */
function createTestFirstInteractionWatchFixture(directory: string) {
  const git = (args: string[], allowed = [0]) => {
    const result = spawnSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 2_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
    });
    if (!allowed.includes(result.status ?? -1)) throw new Error(result.stderr);
  };
  git(["init", "-q"]);
  writeFileSync(join(directory, ".gitignore"), "node_modules/\n");
  for (let branch = 0; branch < 20; branch++) {
    let child = join(directory, `b${branch}`);
    for (let depth = 0; depth < 100; depth++) {
      mkdirSync(child);
      writeFileSync(join(child, "file.txt"), "before\n");
      child = join(child, "d");
    }
  }
  git(["add", "."]);
  git([
    "-c",
    "user.name=Hunk Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);
  writeFileSync(join(directory, "b0", "file.txt"), "after\n");
  git(["update-index", "--refresh"], [0, 1]);
}

// Bun's PTY API is Unix-only. In particular, this exercises Linux's portable watcher backend.
test.skipIf(process.platform === "win32")(
  "answers the first painted frame's key while starting a deeply nested watch",
  async () => {
    const temporary = mkdtempSync(join(tmpdir(), "hunk-watch-first-key-"));
    const fixture = join(temporary, "repo");
    const config = join(temporary, "config");
    mkdirSync(fixture);
    mkdirSync(join(config, "hunk"), { recursive: true });
    let terminal: Bun.Terminal | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      createTestFirstInteractionWatchFixture(fixture);
      writeFileSync(join(config, "hunk", "config.toml"), "watch = true\n");
      const extension = join(temporary, "first-key.ts");
      // Explicit --extension consent loads only test-owned code. writeSync bypasses the TUI's
      // stdout interception; the OSC acknowledgement originates inside real command dispatch.
      writeFileSync(
        extension,
        `import { writeSync } from "node:fs";
export default function (hunk) {
  hunk.registerCommand({ id: "ack", title: "Acknowledge test input", key: "f9" }, (ctx) => {
    writeSync(1, ${JSON.stringify(acknowledgement)});
    ctx.commands.execute("hunk.app.toggleHelp");
  });
}\n`,
      );
      let output = "";
      let sentAt: number | undefined;
      let latency: number | undefined;
      let visibleLatency: number | undefined;
      let resolveInteraction!: () => void;
      let rejectInteraction!: (error: Error) => void;
      const interaction = new Promise<void>((resolvePromise, reject) => {
        resolveInteraction = resolvePromise;
        rejectInteraction = reject;
      });
      watchdog = setTimeout(() => rejectInteraction(new Error("No first frame within 3 s")), 3_000);
      terminal = new Bun.Terminal({
        cols: 120,
        rows: 30,
        name: "xterm-truecolor",
        data(pty, bytes) {
          output += Buffer.from(bytes).toString();
          const text = stripVTControlCharacters(output);
          if (sentAt === undefined && text.includes("File  View")) {
            sentAt = performance.now();
            // No idle wait, warmup, retry, or second key before the dispatch acknowledgement.
            pty.write("\x1b[20~");
            clearTimeout(watchdog);
            watchdog = setTimeout(
              () => rejectInteraction(new Error("No first-key ACK within 1 s")),
              1_000,
            );
          }
          if (sentAt !== undefined && latency === undefined && output.includes(acknowledgement)) {
            latency = performance.now() - sentAt;
            console.log(`first-key dispatch ACK: ${latency.toFixed(1)} ms (${process.platform})`);
            clearTimeout(watchdog);
            watchdog = setTimeout(
              () => rejectInteraction(new Error("No ordinary help response within 2 s")),
              2_000,
            );
          }
          if (
            latency !== undefined &&
            visibleLatency === undefined &&
            text.includes("Controls help")
          ) {
            visibleLatency = performance.now() - sentAt!;
            resolveInteraction();
          }
        },
      });
      child = Bun.spawn(
        [
          process.execPath,
          join(root, "packages/hunk/src/main.tsx"),
          "diff",
          "--theme",
          "github-dark-default",
          "--extension",
          extension,
        ],
        {
          cwd: fixture,
          terminal,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: config,
            HUNK_MCP_DISABLE: "1",
            HUNK_DISABLE_UPDATE_NOTICE: "1",
            TERM: "xterm-truecolor",
            NO_COLOR: undefined,
          },
        },
      );
      await interaction;
      expect(output.split(acknowledgement)).toHaveLength(2);
      console.log(`first-key visible help: ${visibleLatency!.toFixed(1)} ms (${process.platform})`);
      expect(latency).toBeLessThanOrEqual(250);
      // Dispatch can beat the initial traversal even on main; bound the first key's actual
      // UI response too, or an early ACK would hide starvation of the requested render.
      expect(visibleLatency).toBeLessThanOrEqual(750);
    } finally {
      clearTimeout(watchdog);
      try {
        if (child) {
          // The PTY child owns its process group. Also kill surviving group members after
          // the leader exits, so an assertion failure cannot leave a Git subprocess behind.
          if (child.exitCode === null) {
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              child.kill("SIGTERM");
            }
            await Promise.race([child.exited, Bun.sleep(500)]);
          }
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            if (child.exitCode === null) child.kill("SIGKILL");
          }
          await Promise.race([child.exited, Bun.sleep(500)]);
          expect(child.exitCode).not.toBeNull();
        }
      } finally {
        terminal?.close();
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  },
  10_000,
);
