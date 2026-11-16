/**
 * Re-exports Hunk's semantic theme derivation for terminal UI modules.
 *
 * Derivation lives in `core/theme/appTheme.ts` because a headless review session publishes the
 * resolved theme tokens to a browser without loading the terminal UI.
 */
export * from "../core/theme/appTheme";
