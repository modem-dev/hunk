import { spawn } from "node:child_process";
import { once } from "node:events";

/** Remove terminal escape sequences before deciding whether stdin looks like a patch. */
function stripTerminalControl(text: string) {
  return text
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

/** Detect whether generic pager stdin looks like a diff/patch that Hunk should review. */
export function looksLikePatchInput(text: string) {
  const normalized = stripTerminalControl(text.replaceAll("\r\n", "\n"));

  return (
    /^diff --git /m.test(normalized) ||
    (/^--- /m.test(normalized) && /^\+\+\+ /m.test(normalized)) ||
    /^@@ /m.test(normalized)
  );
}

/** Choose a plain-text pager command while avoiding recursive `hunk pager` launches. */
export function resolveTextPagerCommand(env: NodeJS.ProcessEnv = process.env) {
  const candidate = env.HUNK_TEXT_PAGER ?? env.PAGER;

  if (!candidate || /(^|\s)hunk(\s|$)/.test(candidate)) {
    return "less -R";
  }

  return candidate;
}

/** Stream plain text through a normal pager, or write directly when not attached to a terminal. */
export async function pagePlainText(text: string, env: NodeJS.ProcessEnv = process.env) {
  if (!process.stdout.isTTY) {
    process.stdout.write(text);
    return;
  }

  const pagerCommand = resolveTextPagerCommand(env);
  const pager = spawn(pagerCommand, {
    shell: true,
    stdio: ["pipe", "inherit", "inherit"],
    env,
  });

  pager.stdin?.end(text);
  const [, code] = await once(pager, "close");

  if (typeof code === "number" && code !== 0) {
    throw new Error(`Pager command failed: ${pagerCommand}`);
  }
}
