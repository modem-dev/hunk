# Examples

Ready-to-run demo diffs for Hunk.

Each folder tells a small review story and includes the exact command to run from the repository root.

## Quick menu

| Example               | Best for                               | Command                                                                                                                                              |
| --------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1-hello-diff`        | fastest first run                      | `hunk diff examples/1-hello-diff/before.ts examples/1-hello-diff/after.ts`                                                                           |
| `2-mini-app-refactor` | realistic multi-file review            | `hunk patch examples/2-mini-app-refactor/change.patch`                                                                                               |
| `3-agent-review-demo` | inline agent rationale                 | `hunk patch examples/3-agent-review-demo/change.patch --agent-context examples/3-agent-review-demo/agent-context.json`                               |
| `4-ui-polish`         | screenshot-friendly TSX diff           | `hunk diff examples/4-ui-polish/before.tsx examples/4-ui-polish/after.tsx`                                                                           |
| `5-pager-tour`        | line scrolling, paging, and hunk jumps | `hunk diff --pager examples/5-pager-tour/before.ts examples/5-pager-tour/after.ts`                                                                   |
| `6-readme-screenshot` | README screenshot with agent notes     | `hunk patch examples/6-readme-screenshot/change.patch --agent-context examples/6-readme-screenshot/agent-context.json --mode split --theme midnight` |

## Notes

- The patch-based examples include checked-in `change.patch` files, so you can open them without creating a temporary repo.
- The agent demo also includes an `agent-context.json` sidecar to show inline review notes beside the diff.
- The pager tour is intentionally taller than a typical terminal viewport so you can try `↑`, `↓`, `PageUp`, `PageDown`, `Home`, `End`, and `[` / `]` right away.
