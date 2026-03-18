import { Command } from "commander";
import type { CliInput, CommonOptions, LayoutMode } from "./types";

/** Normalize the flags shared by every input mode. */
function buildCommonOptions(options: {
  mode?: LayoutMode;
  theme?: string;
  agentContext?: string;
  pager?: boolean;
}): CommonOptions {
  return {
    mode: options.mode ?? "auto",
    theme: options.theme,
    agentContext: options.agentContext,
    pager: options.pager ?? false,
  };
}

/** Parse CLI arguments into one normalized input shape for the app loader layer. */
export async function parseCli(argv: string[]): Promise<CliInput> {
  if (argv.length <= 2) {
    return {
      kind: "git",
      staged: false,
      options: buildCommonOptions({}),
    };
  }

  let selected: CliInput | null = null;
  const program = new Command();

  program
    .name("hunk")
    .description("Desktop-inspired terminal diff viewer for agent-authored changesets.")
    .showHelpAfterError();

  /** Attach the shared mode/theme/agent-context flags to a subcommand. */
  const applyCommonOptions = (command: Command) =>
    command
      .option("--mode <mode>", "layout mode: auto, split, stack", "auto")
      .option("--theme <theme>", "named theme override")
      .option("--agent-context <path>", "JSON sidecar with agent rationale")
      .option("--pager", "use pager-style chrome and controls", false);

  applyCommonOptions(program.command("git"))
    .argument("[range]", "revision or range to diff")
    .option("--staged", "show staged changes instead of the working tree", false)
    .action((range: string | undefined, options: Record<string, unknown>) => {
      selected = {
        kind: "git",
        range,
        staged: Boolean(options.staged),
        options: buildCommonOptions({
          mode: options.mode as LayoutMode | undefined,
          theme: options.theme as string | undefined,
          agentContext: options.agentContext as string | undefined,
          pager: options.pager as boolean | undefined,
        }),
      };
    });

  applyCommonOptions(program.command("diff"))
    .argument("<left>", "left-hand file")
    .argument("<right>", "right-hand file")
    .action((left: string, right: string, options: Record<string, unknown>) => {
      selected = {
        kind: "diff",
        left,
        right,
        options: buildCommonOptions({
          mode: options.mode as LayoutMode | undefined,
          theme: options.theme as string | undefined,
          agentContext: options.agentContext as string | undefined,
          pager: options.pager as boolean | undefined,
        }),
      };
    });

  applyCommonOptions(program.command("patch"))
    .argument("[file]", "patch file path, or omit / pass - for stdin")
    .action((file: string | undefined, options: Record<string, unknown>) => {
      selected = {
        kind: "patch",
        file,
        options: buildCommonOptions({
          mode: options.mode as LayoutMode | undefined,
          theme: options.theme as string | undefined,
          agentContext: options.agentContext as string | undefined,
          pager: options.pager as boolean | undefined,
        }),
      };
    });

  applyCommonOptions(program.command("difftool"))
    .argument("<left>", "left-hand file from git")
    .argument("<right>", "right-hand file from git")
    .argument("[path]", "display path")
    .action((left: string, right: string, path: string | undefined, options: Record<string, unknown>) => {
      selected = {
        kind: "difftool",
        left,
        right,
        path,
        options: buildCommonOptions({
          mode: options.mode as LayoutMode | undefined,
          theme: options.theme as string | undefined,
          agentContext: options.agentContext as string | undefined,
          pager: options.pager as boolean | undefined,
        }),
      };
    });

  await program.parseAsync(argv);

  if (!selected) {
    throw new Error("No command selected.");
  }

  return selected;
}
