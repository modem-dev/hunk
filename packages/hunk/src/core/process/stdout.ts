/**
 * Hands a finished document to stdout and waits for the consumer to take all of it.
 *
 * Headless commands write their whole document in one call and then exit. Bun's `process.stdout`
 * reports no backpressure for a pipe — `write` returns true and `writableLength` stays 0 while only
 * one pipe buffer (64 KB on Linux) has actually been handed over — so the exit discarded the rest
 * and silently truncated output for every consumer reading through a pipe: Git's pager contract,
 * LazyGit, `| less`. A file or a terminal takes the whole document at once, which is why the loss
 * only appeared under a pipe. Writing straight to the descriptor blocks until the consumer has
 * taken every byte, so the caller can exit as soon as this returns.
 */
import { writeSync } from "node:fs";

const STDOUT_FD = 1;
/** Pause before retrying a descriptor that is momentarily full, rather than spinning on it. */
const NON_BLOCKING_RETRY_MS = 1;

/** Test seams for descriptor writes; production always targets the real stdout descriptor. */
export interface WriteStdoutDeps {
  writeImpl?: (fd: number, buffer: Uint8Array, offset: number, length: number) => number;
  sleepImpl?: (ms: number) => void;
}

/** Write text to stdout, resuming partial writes until the consumer has taken the whole document. */
export function writeStdout(text: string, deps: WriteStdoutDeps = {}) {
  const write = deps.writeImpl ?? writeSync;
  const sleep = deps.sleepImpl ?? Bun.sleepSync;
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;

  while (offset < buffer.length) {
    try {
      offset += write(STDOUT_FD, buffer, offset, buffer.length - offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A consumer that stops reading early (`| head`) leaves nothing left to deliver.
      if (code === "EPIPE") {
        return;
      }
      // Only a non-blocking descriptor reports this, and only until it has room again.
      if (code === "EAGAIN") {
        sleep(NON_BLOCKING_RETRY_MS);
        continue;
      }
      throw error;
    }
  }
}
