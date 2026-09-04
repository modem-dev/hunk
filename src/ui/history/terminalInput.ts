import { StringDecoder } from "node:string_decoder";

const ESCAPE = "\x1b";

/** Splits raw terminal bytes into complete key and mouse tokens across arbitrary chunks. */
export class TerminalInputTokenizer {
  private readonly decoder = new StringDecoder("utf8");
  private buffered = "";

  /** Add one raw input chunk and return every complete token now available. */
  push(chunk: Buffer | string) {
    this.buffered += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    return this.takeCompleteTokens();
  }

  /** Return whether a lone Escape is waiting for a possible sequence suffix. */
  hasStandaloneEscape() {
    return this.buffered === ESCAPE;
  }

  /** Resolve a lone buffered Escape after the terminal's sequence grace period. */
  flushStandaloneEscape() {
    if (!this.hasStandaloneEscape()) return [];
    this.buffered = "";
    return [ESCAPE];
  }

  /** Flush decoder state and expose any remaining input when the stream closes. */
  finish() {
    this.buffered += this.decoder.end();
    const tokens = this.takeCompleteTokens();
    if (this.buffered) {
      tokens.push(...Array.from(this.buffered));
      this.buffered = "";
    }
    return tokens;
  }

  /** Consume complete characters, CSI sequences, and SS3 sequences from the buffer. */
  private takeCompleteTokens() {
    const tokens: string[] = [];
    while (this.buffered) {
      if (!this.buffered.startsWith(ESCAPE)) {
        const token = String.fromCodePoint(this.buffered.codePointAt(0)!);
        tokens.push(token);
        this.buffered = this.buffered.slice(token.length);
        continue;
      }

      if (this.buffered.length === 1) break;
      const prefix = this.buffered[1];
      if (prefix === "[") {
        let finalIndex = -1;
        for (let index = 2; index < this.buffered.length; index += 1) {
          const code = this.buffered.charCodeAt(index);
          if (code >= 0x40 && code <= 0x7e) {
            finalIndex = index;
            break;
          }
        }
        if (finalIndex < 0) break;
        tokens.push(this.buffered.slice(0, finalIndex + 1));
        this.buffered = this.buffered.slice(finalIndex + 1);
        continue;
      }

      if (prefix === "O") {
        if (this.buffered.length < 3) break;
        tokens.push(this.buffered.slice(0, 3));
        this.buffered = this.buffered.slice(3);
        continue;
      }

      // Hunk has no Alt-key bindings here, so preserve Escape as its own action.
      tokens.push(ESCAPE);
      this.buffered = this.buffered.slice(1);
    }
    return tokens;
  }
}

/** Queues tokenized terminal input while allowing terminal ownership to pause for child review. */
export class TerminalInputReader {
  private readonly tokenizer = new TerminalInputTokenizer();
  private readonly queued: string[] = [];
  private readonly waiting: Array<{
    resolve: (token: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private escapeTimer: ReturnType<typeof setTimeout> | undefined;
  private endedError: Error | undefined;

  constructor(private readonly stream: NodeJS.ReadStream) {
    stream.on("data", this.onData);
    stream.on("end", this.onEnd);
    stream.on("error", this.onError);
  }

  /** Resume delivery from the caller-owned terminal stream. */
  resume() {
    this.stream.resume();
  }

  /** Pause delivery while another process owns the terminal. */
  pause() {
    this.clearEscapeTimer();
    this.stream.pause();
  }

  /** Return the next complete token, allowing a temporary caller to cancel its wait. */
  next(signal?: AbortSignal) {
    const token = this.queued.shift();
    if (token !== undefined) return Promise.resolve(token);
    if (this.endedError) return Promise.reject(this.endedError);
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("Terminal input wait aborted."));
    }
    return new Promise<string>((resolve, reject) => {
      const waiter = {
        resolve: (value: string) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error: Error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        waiter.reject(signal?.reason ?? new Error("Terminal input wait aborted."));
      };
      this.waiting.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Restore temporarily consumed tokens to the front of the input queue. */
  prepend(tokens: readonly string[]) {
    this.queued.unshift(...tokens);
  }

  /** Drop typeahead before transferring terminal ownership to a child process. */
  discardPending() {
    this.queued.length = 0;
  }

  /** Detach listeners and reject any pending read. */
  close(error = new Error("Terminal input closed.")) {
    this.finish(error, false);
  }

  private readonly onData = (chunk: Buffer | string) => {
    this.clearEscapeTimer();
    this.enqueue(this.tokenizer.push(chunk));
    if (this.tokenizer.hasStandaloneEscape()) {
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = undefined;
        this.enqueue(this.tokenizer.flushStandaloneEscape());
      }, 25);
      this.escapeTimer.unref?.();
    }
  };

  private readonly onEnd = () => this.finish(new Error("Terminal input closed."), true);
  private readonly onError = (error: Error) => this.finish(error, true);

  private enqueue(tokens: string[]) {
    for (const token of tokens) {
      const waiter = this.waiting.shift();
      if (waiter) waiter.resolve(token);
      else this.queued.push(token);
    }
  }

  private finish(error: Error, flush: boolean) {
    if (this.endedError) return;
    this.clearEscapeTimer();
    if (flush) this.enqueue(this.tokenizer.finish());
    this.endedError = error;
    this.stream.off("data", this.onData);
    this.stream.off("end", this.onEnd);
    this.stream.off("error", this.onError);
    this.stream.pause();
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }

  private clearEscapeTimer() {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
  }
}
