/**
 * Re-exports terminal text measurement for terminal UI modules.
 *
 * Measurement lives in `lib/text.ts` because the deterministic STML layout in `core/stml/` measures
 * with it too, and that layout must be importable without the terminal UI.
 */
export * from "../../lib/text";
