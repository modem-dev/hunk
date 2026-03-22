# 5-pager-tour

A tall single-file diff made to show line scrolling, paging, and hunk jumps.

## Run

```bash
hunk diff --pager examples/5-pager-tour/before.ts examples/5-pager-tour/after.ts
```

## What to look for

- enough changed content to exceed a normal terminal viewport
- `↑` and `↓` for line-by-line movement
- `PageUp`, `PageDown`, `Home`, and `End` for larger jumps
- multiple hunks so `[` and `]` are worth trying too
