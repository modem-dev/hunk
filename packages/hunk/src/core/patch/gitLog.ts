/**
 * Strip `git log -p` / `git show -p` commit metadata so the surviving text
 * is a plain patch stream that `@pierre/diffs` can parse without spamming
 * `parseLineType: Invalid firstChar` warnings on every commit boundary.
 *
 * Each commit in `git log -p` looks like:
 *
 * ```
 * commit <sha>[ (refs)]
 * Author: ...
 * Date:   ...
 *
 *     <commit message>
 *
 * diff --git a/foo b/foo
 * ...
 * ```
 *
 * Lines from `commit ` through the first patch header (`diff --git `,
 * `--- `, or `+++ `) are dropped. Hunk-body lines always start with
 * `+`, `-`, ` ` or `\`, so a real context line that begins with the word
 * "commit" is unaffected (its leading space prevents the regex match).
 *
 * Returns the input unchanged when no `commit <sha>` boundary is present,
 * keeping the regular patch path zero-cost.
 */
export function stripGitLogMetadata(text: string) {
  // Hex range up to 64 covers both SHA-1 (40) and SHA-256 (64) repos.
  const COMMIT_BOUNDARY = /^commit [0-9a-f]{4,64}(?: |$)/m;
  if (!COMMIT_BOUNDARY.test(text)) {
    return text;
  }

  const lines = text.split("\n");
  const out: string[] = [];
  let inHeader = false;

  for (const line of lines) {
    if (COMMIT_BOUNDARY.test(line)) {
      inHeader = true;
      continue;
    }
    if (inHeader) {
      // The header section ends at the first patch line. `diff --git `
      // is the canonical Git start; `--- `/`+++ ` cover unified-diff
      // input where someone synthesised log output without it.
      if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
        inHeader = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }

  return out.join("\n");
}
