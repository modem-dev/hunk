import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Windows CI excludes the PTY test group, including this native screen parser.
import { PersistentTerminal } from "ghostty-opentui";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const overlays = [
  { name: "help", key: "?", marker: "Controls help" },
  { name: "menu", key: "\x1b[21~", marker: "Toggle files/filter focus" },
];

/** Create one tracked, changed file without user Git configuration or hooks. */
function createTestDialogFixture(directory: string) {
  const git = (args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 2_000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(directory, "absent-gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
      },
    });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(["init", "-q"]);
  writeFileSync(join(directory, "example.ts"), "export const value = 1;\n");
  git(["add", "example.ts"]);
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
  writeFileSync(join(directory, "example.ts"), "export const value = 2;\n");
}

// React act() bypasses the Suspense retry throttle, and the ordinary PTY harness warms up
// keyboard handling. Neither can detect a first-use overlay suspended behind a null fallback.
for (const overlay of overlays) {
  for (const idle of [false, true]) {
    test.skipIf(process.platform === "win32")(
      `opens ${overlay.name} promptly ${idle ? "after two seconds idle" : "from the first frame"}`,
      async () => {
        const screen = new PersistentTerminal({ cols: 120, rows: 30 });
        const temporary = mkdtempSync(join(tmpdir(), "hunk-dialog-first-open-"));
        const fixture = join(temporary, "repo");
        const config = join(temporary, "config");
        mkdirSync(fixture);
        mkdirSync(join(config, "hunk"), { recursive: true });
        let terminal: Bun.Terminal | undefined;
        let child: ReturnType<typeof Bun.spawn> | undefined;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        let pending: ReturnType<typeof setTimeout> | undefined;
        const chunks: Buffer[] = [];
        try {
          createTestDialogFixture(fixture);
          writeFileSync(join(config, "hunk", "config.toml"), "watch = false\n");
          let stage = "frame";
          let startedAt = 0;
          let frameMs = 0;
          let sentAt = 0;
          const opens: number[] = [];
          let resolveInteraction!: () => void;
          let rejectInteraction!: (error: Error) => void;
          const interaction = new Promise<void>((done, fail) => {
            resolveInteraction = done;
            rejectInteraction = fail;
          });
          /** Bound each real screen transition, including close, rather than dispatch ACKs. */
          const guard = (message: string, milliseconds = 1_000) => {
            clearTimeout(watchdog);
            watchdog = setTimeout(() => rejectInteraction(new Error(message)), milliseconds);
          };
          /** Send exactly one key; the first send has no warmup, idle helper, or retry. */
          const open = (pty: Bun.Terminal) => {
            stage = "opening";
            sentAt = performance.now();
            pty.write(overlay.key);
            guard(`No visible ${overlay.name} within 1 s`);
          };
          guard("No first frame within 3 s", 3_000);
          terminal = new Bun.Terminal({
            cols: 120,
            rows: 30,
            name: "xterm-truecolor",
            data(pty, bytes) {
              chunks.push(Buffer.from(bytes));
              screen.feed(bytes);
              const text: string = screen.getText();
              if (stage === "frame" && text.includes("File  View")) {
                frameMs = performance.now() - startedAt;
                clearTimeout(watchdog);
                if (idle) {
                  stage = "idle";
                  pending = setTimeout(() => open(pty), 2_000);
                } else open(pty);
              } else if (stage === "opening" && text.includes(overlay.marker)) {
                opens.push(performance.now() - sentAt);
                clearTimeout(watchdog);
                if (opens.length === 2) {
                  stage = "done";
                  resolveInteraction();
                } else {
                  stage = "close-delay";
                  pending = setTimeout(() => {
                    stage = "closing";
                    pty.write("\x1b");
                    guard(`No screen-verified ${overlay.name} close within 1 s`);
                  }, 100);
                }
              } else if (stage === "closing" && !text.includes(overlay.marker)) {
                clearTimeout(watchdog);
                stage = "reopen-delay";
                pending = setTimeout(() => open(pty), 100);
              }
            },
          });
          const command = process.env.HUNK_TEST_EXECUTABLE
            ? [resolve(root, process.env.HUNK_TEST_EXECUTABLE)]
            : [process.execPath, join(root, "packages/hunk/src/main.tsx")];
          startedAt = performance.now();
          child = Bun.spawn(
            [...command, "diff", "--no-extensions", "--theme", "github-dark-default"],
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
          void child.exited.then((code) => {
            if (stage !== "done") rejectInteraction(new Error(`Hunk exited early: ${code}`));
          });
          await interaction;
          console.log(
            JSON.stringify({
              host: process.platform,
              overlay: overlay.name,
              idle,
              frameMs,
              firstMs: opens[0],
              reopenMs: opens[1],
            }),
          );
          // Leave headroom for startup highlighting/host-tree construction but reject the
          // ~300 ms fallback throttle. Keep the differential gate as well as absolute bounds.
          expect(opens[0]).toBeLessThanOrEqual(idle ? 150 : 200);
          expect(opens[0]! - opens[1]!).toBeLessThanOrEqual(150);
        } catch (error) {
          const artifacts = mkdtempSync(join(tmpdir(), "hunk-dialog-failure-"));
          writeFileSync(join(artifacts, "output.terminal"), Buffer.concat(chunks));
          writeFileSync(join(artifacts, "screen.txt"), screen.getText());
          console.error(`First-open PTY evidence: ${artifacts}`);
          throw error;
        } finally {
          clearTimeout(watchdog);
          clearTimeout(pending);
          try {
            if (child) {
              // The PTY child leads a process group; reap Git descendants even if it exited.
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
            screen.destroy();
            rmSync(temporary, { recursive: true, force: true });
          }
        }
      },
      10_000,
    );
  }
}
