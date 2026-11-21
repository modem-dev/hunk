/**
 * Runs `hunk feedback`: collects the message, validates it, shows exactly what will be sent and
 * where, asks, and only then sends.
 *
 * The privacy contract is enforced by ordering. Every exit before the send (disabled config,
 * validation errors, `--dry-run`, a refused unattended run, and a declined prompt) returns before
 * `loadSend` is called, so those runs never load the module that knows the endpoint, let alone
 * make a request. `--skip-confirm` skips only the prompt; the disclosure and request body still
 * print to stderr so a log records what was sent. The confirmation reader comes from the caller,
 * which reads it from the controlling terminal rather than stdin, so a piped message can still be
 * confirmed at the keyboard.
 */

import type { FeedbackCommandInput } from "../run/commandInputs";
import { resolveCliVersion } from "../run/version";
import {
  buildFeedbackPayload,
  createFeedbackSubmissionId,
  describeFeedbackDisclosure,
  formatFeedbackPreview,
  validateFeedbackDraft,
  type FeedbackEnvironment,
  type FeedbackPayload,
} from "./payload";
import type { FeedbackSendResult, sendFeedback } from "./send";

export type FeedbackConfirm = (question: string) => Promise<boolean>;

export interface FeedbackCommandDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Whether config offers feedback at all. */
  feedbackEnabled: boolean;
  /** Ask on the controlling terminal; absent when no terminal can answer. */
  confirm?: FeedbackConfirm;
  /** Open the interactive form when no message was given; absent without a terminal. */
  openForm?: (initial: { email?: string }) => Promise<number>;
  environment?: FeedbackEnvironment;
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  createSubmissionId?: () => string;
  /** Load the send module. Called only after confirmation. */
  loadSend?: () => Promise<typeof sendFeedback>;
  /** Column the disclosure wraps at; defaults to the terminal width, capped for readability. */
  wrapWidth?: number;
}

const MAX_WRAP_WIDTH = 100;

/**
 * The CLI's own unconfirmed message. Unlike the form, each `hunk feedback` run makes a new
 * submission ID, so running it again cannot be deduplicated and the text must not promise that.
 */
export const CLI_UNCONFIRMED_MESSAGE =
  "Hunk couldn't confirm that Modem received this. It may have arrived, and running hunk feedback again would send a second copy.";

/** Exit status for a refused or invalid run that sent nothing. */
const EXIT_REFUSED = 2;

/** Load the send module lazily so unconfirmed runs never load the endpoint or token. */
async function loadDefaultSend() {
  return (await import("./send")).sendFeedback;
}

/** Read the message from the positional words, `--message`, or `--file`. */
async function collectMessage(input: FeedbackCommandInput, deps: FeedbackCommandDeps) {
  if (input.message !== undefined) {
    return input.message;
  }

  if (input.file === "-") {
    return (deps.readStdin ?? (() => new Response(Bun.stdin.stream()).text()))();
  }

  if (input.file !== undefined) {
    return (deps.readFile ?? ((path: string) => Bun.file(path).text()))(input.file);
  }

  return undefined;
}

/** Wrap one prose paragraph at word boundaries; a word longer than the width keeps its own line. */
export function wrapFeedbackParagraph(paragraph: string, width: number) {
  return paragraph
    .split("\n")
    .flatMap((source) => {
      const bullet = source.startsWith("- ");
      const indent = bullet ? "  " : "";
      const lines: string[] = [];
      let line = "";
      for (const word of (bullet ? source.slice(2) : source).split(/\s+/).filter(Boolean)) {
        if (line.length > 0 && indent.length + line.length + 1 + word.length > width) {
          lines.push(line);
          line = word;
        } else {
          line = line.length > 0 ? `${line} ${word}` : word;
        }
      }
      if (line.length > 0) lines.push(line);
      return lines.map((text, index) => `${index === 0 && bullet ? "- " : indent}${text}`);
    })
    .join("\n");
}

/** Render the disclosure and the exact request body, as shown before every send. */
export function formatFeedbackCommandPreview(
  payload: FeedbackPayload,
  environment: FeedbackEnvironment,
  wrapWidth = MAX_WRAP_WIDTH,
  skipsConfirmation = false,
) {
  return [
    ...describeFeedbackDisclosure({
      ...environment,
      includesEmail: payload.email !== undefined,
      skipsConfirmation,
    }).map((paragraph) => wrapFeedbackParagraph(paragraph, wrapWidth)),
    `Request body:\n${formatFeedbackPreview(payload)}`,
  ].join("\n\n");
}

/** Report a run that sent nothing, as text or JSON. */
function reportNotSent(
  input: FeedbackCommandInput,
  deps: FeedbackCommandDeps,
  reason: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  if (input.output === "json") {
    deps.stdout(`${JSON.stringify({ sent: false, reason, ...extra })}\n`);
  } else {
    deps.stdout(`${text}\n`);
  }
}

/** Print one send result and return the command's exit status. */
function reportResult(
  input: FeedbackCommandInput,
  deps: FeedbackCommandDeps,
  payload: FeedbackPayload,
  result: FeedbackSendResult,
) {
  if (result.kind === "sent") {
    if (input.output === "json") {
      deps.stdout(
        `${JSON.stringify({ sent: true, id: result.id, submission_id: payload.submission_id })}\n`,
      );
    } else {
      deps.stdout(`Sent. Thanks!${result.id ? ` Reference: ${result.id}` : ""}\n`);
    }
    return 0;
  }

  const message = result.kind === "unconfirmed" ? CLI_UNCONFIRMED_MESSAGE : result.message;
  if (input.output === "json") {
    deps.stdout(
      `${JSON.stringify({ sent: false, reason: result.kind, message, submission_id: payload.submission_id })}\n`,
    );
  } else {
    deps.stderr(`${message}\n`);
  }
  return 1;
}

/** Run one `hunk feedback` invocation and return its exit status. */
export async function runFeedbackCommand(
  input: FeedbackCommandInput,
  deps: FeedbackCommandDeps,
): Promise<number> {
  if (!deps.feedbackEnabled) {
    deps.stderr("Feedback is disabled by configuration ([feedback] enabled = false).\n");
    return EXIT_REFUSED;
  }

  const message = await collectMessage(input, deps);
  if (message === undefined) {
    if (input.dryRun) {
      deps.stderr("--dry-run needs a message: pass it as words, with --message, or with --file.\n");
      return EXIT_REFUSED;
    }

    if (deps.openForm) {
      return deps.openForm({ email: input.email });
    }

    deps.stderr(
      "hunk feedback needs a message without a terminal: pass it as words, with --message, or with --file.\n",
    );
    return EXIT_REFUSED;
  }

  const validation = validateFeedbackDraft({ message, email: input.email });
  if (!validation.ok) {
    deps.stderr(`${validation.error}\n`);
    return EXIT_REFUSED;
  }

  const environment = deps.environment ?? {
    version: resolveCliVersion(),
    platform: process.platform,
  };
  const payload = buildFeedbackPayload(validation.draft, {
    ...environment,
    surface: "cli",
    submissionId: (deps.createSubmissionId ?? createFeedbackSubmissionId)(),
  });
  const preview = formatFeedbackCommandPreview(
    payload,
    environment,
    deps.wrapWidth ?? Math.min(process.stderr.columns || 80, MAX_WRAP_WIDTH),
    input.skipConfirm && !input.dryRun,
  );

  if (input.dryRun) {
    if (input.output === "json") {
      deps.stdout(`${JSON.stringify({ sent: false, reason: "dry-run", payload })}\n`);
    } else {
      deps.stdout(`${preview}\n\nDry run: nothing was sent.\n`);
    }
    return 0;
  }

  deps.stderr(`${preview}\n\n`);

  if (!input.skipConfirm) {
    if (!deps.confirm) {
      deps.stderr(
        "hunk feedback needs confirmation. Re-run in a terminal, or pass --skip-confirm to send without one.\n",
      );
      return EXIT_REFUSED;
    }

    if (!(await deps.confirm("Send this feedback to Modem? [y/N] "))) {
      reportNotSent(input, deps, "cancelled", "Not sent.");
      return 0;
    }
  }

  const send = await (deps.loadSend ?? loadDefaultSend)();
  return reportResult(input, deps, payload, await send(payload));
}
