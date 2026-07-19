/** One transient message shown in the footer during app startup. */
export interface StartupNotice {
  key: string;
  message: string;
}

/** Warn when Hunk had to approximate deprecated semantic syntax colors. */
export const LEGACY_CUSTOM_SYNTAX_NOTICE: StartupNotice = {
  key: "deprecated:custom-theme-syntax",
  message:
    "Deprecated [custom_theme.syntax] translated approximately • migrate to [custom_theme.syntax_scopes]",
};
