# Examples

Ready-to-run demos for Hunk and the exported OpenTUI diff component.

Each folder tells a small review story and includes the exact command to run from the repository root.

## Quick menu

| Example                | Best for                               | Command                                                                                                                                              |
| ---------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1-hello-diff`         | fastest first run                      | `hunk diff --files examples/1-hello-diff/before.ts examples/1-hello-diff/after.ts`                                                                   |
| `2-mini-app-refactor`  | realistic multi-file review            | `hunk patch examples/2-mini-app-refactor/change.patch`                                                                                               |
| `3-agent-review-demo`  | inline agent rationale                 | `hunk patch examples/3-agent-review-demo/change.patch --agent-context examples/3-agent-review-demo/agent-context.json`                               |
| `4-ui-polish`          | screenshot-friendly TSX diff           | `hunk diff --files examples/4-ui-polish/before.tsx examples/4-ui-polish/after.tsx`                                                                   |
| `5-pager-tour`         | line scrolling, paging, and hunk jumps | `hunk diff --files examples/5-pager-tour/before.ts examples/5-pager-tour/after.ts --pager`                                                           |
| `6-readme-screenshot`  | README screenshot with agent notes     | `hunk patch examples/6-readme-screenshot/change.patch --agent-context examples/6-readme-screenshot/agent-context.json --mode split --theme midnight` |
| `7-opentui-component`  | embedding `HunkDiffView` in OpenTUI    | `bun run examples/7-opentui-component/from-files.tsx`                                                                                                |
| `8-opentui-primitives` | composing Hunk's OpenTUI primitives    | `bun run examples/8-opentui-primitives/primitives-demo.tsx`                                                                                          |
| `9-agent-markup-notes` | STML markup rendered inside notes      | `hunk patch examples/9-agent-markup-notes/change.patch --agent-context examples/9-agent-markup-notes/agent-context.json`                             |

## Installable extension examples

- [`extensions/github-pr/`](extensions/github-pr/) adds a dependency-free `hunk gh 123` command that fetches GitHub PR diffs directly and delegates them into Hunk.
- [`extensions/cli-tools/`](extensions/cli-tools/) demonstrates the minimal generic CLI exit and delegation contracts.
- [`extensions/review-triage/`](extensions/review-triage/) adds a session-local hunk triage sidebar.
- [`extensions/review-note-navigator/`](extensions/review-note-navigator/) inventories every saved ReviewStore note and navigates to visible authoritative anchors.
- [`extensions/review-snapshot-export/`](extensions/review-snapshot-export/) exports stable file identities and every saved ReviewStore note with a stale-work guard.
- [`extensions/rendered-markdown/`](extensions/rendered-markdown/) adds an optional parsed Markdown file presentation.
- [`extensions/inline-edit/`](extensions/inline-edit/) edits the file under review in place, composing a file-view mode, layout refresh, and host-mediated workspace writes.
- [`extensions/jsx-file-view/`](extensions/jsx-file-view/) is the smallest hook-using fixed-row JSX proof of concept.
- [`extensions/jsx-file-view-gallery/`](extensions/jsx-file-view-gallery/) runs three constrained-JSX presentations against checked-in TypeScript, CSS, and `package.json` diffs: an impact atlas, real color swatches, and highlighted dependency versions.

Extension examples are not bundled with Hunk. Each README shows how to try or install its folder explicitly.

## Notes

- The patch-based examples include checked-in `change.patch` files, so you can open them without creating a temporary repo.
- The agent demo also includes an `agent-context.json` sidecar to show inline review notes beside the diff.
- The pager tour is intentionally taller than a typical terminal viewport so you can try `↑`, `↓`, `PageUp`, `PageDown`, `Home`, `End`, and `[` / `]` right away.
- The OpenTUI component example folder also includes `from-patch.tsx` if you want the same demo driven by raw unified diff text instead of `before` / `after` contents.
- The OpenTUI primitives example shows how to assemble a custom review UI from Hunk's exported building blocks.
