/**
 * Re-exports the deterministic STML line layout for terminal note rendering.
 *
 * Layout and parsing live in `core/stml/` so the renderer-free review session host validates live
 * comment markup with the same `(markup, width)` answer the terminal renders.
 */
export * from "../../../core/stml/layout";
