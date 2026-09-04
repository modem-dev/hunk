/** Options for rendering a unified patch as a non-interactive terminal diff. */
export interface StaticDiffOptions {
  /** Stack changed lines vertically or place deletion/addition lines side by side. Defaults to stack. */
  layout?: "stack" | "split";
  /** Built-in Hunk theme id. Unknown ids fall back to the default theme. */
  theme?: string;
  /** Show old and new line-number gutters. Defaults to true. */
  lineNumbers?: boolean;
  /** Show unified hunk headers. Defaults to true. */
  hunkHeaders?: boolean;
  /** Source-code tab stop width from 1 through 16. Defaults to 4. */
  tabWidth?: number;
  /** Keep neutral surfaces transparent while preserving changed-line backgrounds. */
  transparentBackground?: boolean;
  /** Available terminal columns. Defaults to stdout columns or 120 when unavailable. */
  width?: number;
}
