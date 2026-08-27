import { HunkExtensionUserError, type HunkExtensionAPI } from "hunkdiff/extension";

/** Wait briefly while remaining responsive to command cancellation. */
async function prepareReview(signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 100);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Register a generic command tree with direct and delegated actions. */
export default function cliToolsExtension(hunk: HunkExtensionAPI) {
  hunk.registerCliCommand(
    {
      name: "cli-tools",
      summary: "Demonstrate extension-provided CLI workflows",
      usage: "<status|review> [args...]",
    },
    async (args, ctx) => {
      const [action, ...rest] = args;
      if (action === "status") {
        await ctx.stdout.write(`cli-tools is ready in ${ctx.cwd}\n`);
        return { kind: "exit" };
      }

      if (action === "review") {
        await ctx.stderr.write("Preparing review input…\n");
        await prepareReview(ctx.signal);
        return { kind: "delegate", argv: ["diff", ...rest] };
      }

      throw new HunkExtensionUserError("Choose a cli-tools action.", {
        suggestions: ["Run `hunk cli-tools status` or `hunk cli-tools review`."],
      });
    },
  );
}
