/**
 * Whether the browser review entry points are released to users.
 *
 * Every user-reachable way into the web review reads this one switch: the `--web`, `--no-open`,
 * and `--no-watch` review flags (hidden from `--help`, shell completions, and generated docs
 * while false), `hunk session open` (absent from `hunk session --help`, completions, docs, and
 * the generated review skill), and the terminal's "Open in browser" command (absent from menus
 * and help). They all parse and run while hidden, so tests and early adopters can use them.
 * M5 flips this to `true` together with the `minor` changeset that announces the feature.
 */
export const WEB_REVIEW_ENTRY_POINTS_RELEASED: boolean = false;
