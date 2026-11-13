/**
 * Opens this process's live review in a browser, or hands its URL to the person who asked.
 *
 * Three triggers converge here: a headless `--web` run opening its review after printing the
 * URL, `hunk session open [selector]` reaching this session through the daemon, and the
 * terminal's "Open in browser" command. All of them describe the same URL, built from the
 * process capability (`../review/capability.ts`) and the daemon's HTTP origin.
 *
 * The capability never leaves this process unless a person asks for the URL itself:
 *
 * - **Open (the default):** this process launches the browser, so the token goes from here
 *   straight to the opener's argument vector (or, on Windows, its environment). The daemon
 *   relays only the request and a yes/no answer; the CLI that asked never sees the token.
 * - **Print (`--no-open`):** the URL travels back as the command result over the
 *   authenticated loopback connection, through daemon memory only for the length of one
 *   relay. Nothing records command results, and the daemon keeps holding only the digest.
 *
 * A launch failure is reported without the URL, because opener diagnostics end up in
 * terminals, logs, and bug reports.
 */
import { openUrlInBrowser, type OpenUrlResult } from "../../core/process/openUrl";
import { resolveSessionBrokerConfig } from "../../session/broker/brokerConfig";
import type { OpenedReviewResult } from "../../session/types";
import { reviewProcessUrl } from "../review/capability";

/** Opens one URL; tests inject a recorder so no browser starts. */
export type ReviewUrlOpener = (url: string) => Promise<OpenUrlResult>;

export interface OpenSessionReviewOptions {
  /** False returns the URL instead of launching a browser. */
  open: boolean;
  env?: NodeJS.ProcessEnv;
  openUrl?: ReviewUrlOpener;
}

/** The URL a browser opens to review this process's session. */
export function sessionReviewUrl(sessionId: string, env?: NodeJS.ProcessEnv) {
  return reviewProcessUrl(resolveSessionBrokerConfig(env).httpOrigin, sessionId);
}

/** Open this session's review in a browser, or return its URL when asked not to open it. */
export async function openSessionReview(
  sessionId: string,
  options: OpenSessionReviewOptions,
): Promise<OpenedReviewResult> {
  const url = sessionReviewUrl(sessionId, options.env);
  if (!options.open) {
    return { opened: false, url };
  }

  const result = await (options.openUrl ?? ((target) => openUrlInBrowser(target)))(url);
  return result.ok ? { opened: true } : { opened: false, failure: result.reason };
}
