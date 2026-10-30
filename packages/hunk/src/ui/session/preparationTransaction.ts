/** Cancel and drain one history/status preparation before another route can become usable. */
export function createPreparationTransaction() {
  let active: {
    controller: AbortController;
    signal: AbortSignal;
    settlement: Promise<void>;
    settle: () => void;
  } | null = null;

  return {
    get pending() {
      return active !== null;
    },

    /** Reserve preparation synchronously; callers retain route identity and resource cleanup. */
    begin(externalSignal: AbortSignal) {
      if (active) throw new Error("Hunk surface preparation is already pending.");
      const controller = new AbortController();
      let settle!: () => void;
      const settlement = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const transaction = {
        controller,
        signal: AbortSignal.any([externalSignal, controller.signal]),
        settlement,
        settle,
      };
      active = transaction;
      return transaction;
    },

    /** Invalidate late results immediately and wait for the caller's resource cleanup. */
    cancel(reason = new Error("Hunk surface preparation was cancelled.")) {
      active?.controller.abort(reason);
      return active?.settlement ?? Promise.resolve();
    },

    /** Release the reservation only after preparation and disposal have both finished. */
    finish(transaction: NonNullable<typeof active>) {
      if (active === transaction) active = null;
      transaction.settle();
    },
  };
}
