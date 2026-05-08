import type { AppTheme } from "../../themes";

/**
 * Render the verbatim commit metadata block. Mirrors the `git log -p` look in `less`:
 * dimmed text, no border or chrome, one trailing blank row to visually separate the
 * message from whatever comes below.
 *
 * Used in two places: at the top of the DiffPane content in commit-review mode (one
 * block describes the whole active commit), and inline above each commit's first file
 * in the explicit `--no-review` flat-streaming mode (where many commits scroll past
 * and each one needs its own header).
 */
export function CommitHeaderBlock({ text, theme }: { text: string; theme: AppTheme }) {
  // Trim trailing newlines and split so we render exactly the captured lines, then add
  // one blank row below to mirror `git log`'s spacing in `less`.
  const lines = text.replace(/\n+$/, "").split("\n");
  return (
    <box style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
      {lines.map((line, index) => (
        <box key={index} style={{ width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text fg={theme.muted}>{line}</text>
        </box>
      ))}
      <box style={{ width: "100%", height: 1 }} />
    </box>
  );
}
