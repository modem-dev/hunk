/**
 * Re-exports the line-highlight contract for the terminal paint pipeline.
 *
 * Validation lives in `core/highlights/validate.ts` because extension highlighters and agent
 * attention marks answer to the same contract, and agent marks are owned by the renderer-free
 * review session host.
 */
export * from "../../core/highlights/validate";
