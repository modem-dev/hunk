/**
 * Which app surface currently owns keyboard input.
 *
 * - `"diff"`: the main review stream (default on launch). Step keys scroll
 *   the diff one row at a time.
 * - `"files"`: the sidebar file list. Step keys move the file selection
 *   instead of scrolling.
 * - `"filter"`: the file filter input is active. The input swallows every
 *   keystroke (including Tab) so users can type literal characters; Esc
 *   exits the input.
 */
export type FocusArea = "files" | "diff" | "filter";
