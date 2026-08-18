export interface VimNavigationKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
  shift?: boolean;
}

export type VimNavigationResult = "handled" | "pass";
export type VimCommandResult = "handled" | "empty" | "unknown";

export interface VimNavigationCommands {
  execute(commandId: string, options?: { count?: number }): boolean;
}

const MAX_COUNT = 10_000;

const RELATIVE_COMMANDS: Readonly<Record<string, string>> = {
  j: "hunk.review.stepDown",
  k: "hunk.review.stepUp",
  "[": "hunk.review.previousHunk",
  "]": "hunk.review.nextHunk",
};

const ALIGNMENT_COMMANDS: Readonly<Record<string, string>> = {
  t: "hunk.review.alignCurrentLineTop",
  z: "hunk.review.alignCurrentLineCenter",
  b: "hunk.review.alignCurrentLineBottom",
};

const CONTROL_COMMANDS: Readonly<Record<string, string>> = {
  d: "hunk.review.halfPageDown",
  u: "hunk.review.halfPageUp",
};

/** Execute one small Ex-style command using only public semantic commands. */
export function executeVimCommand(
  input: string,
  commands: VimNavigationCommands,
): VimCommandResult {
  const command = input.trim().replace(/^:/, "").trim();
  if (command.length === 0) return "empty";

  if (command === "top") {
    commands.execute("hunk.review.jumpToTop");
    return "handled";
  }
  if (command === "bottom") {
    commands.execute("hunk.review.jumpToBottom");
    return "handled";
  }
  return "unknown";
}

/** Build the small Vim-normal grammar independently from Hunk's key router. */
export function createVimNavigationState(commands: VimNavigationCommands) {
  let countText = "";
  let prefix: "g" | "z" | null = null;

  /** Clear every partially entered sequence. */
  const reset = () => {
    countText = "";
    prefix = null;
  };

  /** Resolve the positive count, already saturated to the host's public maximum. */
  const count = () => (countText.length > 0 ? Number(countText) : 1);

  /** Execute one relative semantic command atomically. */
  const executeRelative = (commandId: string) => {
    const magnitude = count();
    reset();
    commands.execute(commandId, { count: magnitude });
    return "handled" as const;
  };

  /** Interpret one key and either claim it or return it to Hunk unchanged. */
  const handleKey = (key: VimNavigationKey): VimNavigationResult => {
    const text = key.sequence || key.name || "";
    const shiftedG = text === "G" || (key.name === "g" && key.shift === true);

    if (key.ctrl) {
      const commandId =
        !key.meta && !key.option && !key.shift
          ? CONTROL_COMMANDS[key.name || key.sequence || ""]
          : undefined;
      if (commandId) return executeRelative(commandId);
      reset();
      return "pass";
    }
    if (key.meta || key.option) {
      reset();
      return "pass";
    }

    if (/^[0-9]$/.test(text)) {
      // A bare zero is a Hunk layout command, not a positive Vim count.
      if (text === "0" && countText.length === 0) {
        reset();
        return "pass";
      }
      if (prefix !== null) {
        reset();
        return "pass";
      }

      const next = Math.min(MAX_COUNT, Number(`${countText}${text}`));
      countText = String(next);
      return "handled";
    }

    if (prefix === "g") {
      const matches = text === "g" && !shiftedG;
      reset();
      if (!matches) return "pass";
      commands.execute("hunk.review.jumpToTop");
      return "handled";
    }

    if (prefix === "z") {
      const commandId = ALIGNMENT_COMMANDS[text];
      reset();
      if (!commandId) return "pass";
      commands.execute(commandId);
      return "handled";
    }

    // The registered `;` command opens a host dialog after this mode passes the key onward.
    if (text === ";") {
      reset();
      return "pass";
    }

    const relative = RELATIVE_COMMANDS[text];
    if (relative) return executeRelative(relative);

    if (shiftedG) {
      reset();
      commands.execute("hunk.review.jumpToBottom");
      return "handled";
    }

    if (text === "g" || text === "z") {
      prefix = text;
      return "handled";
    }

    reset();
    return "pass";
  };

  return { handleKey, reset };
}
