---
---

Add render-level unit coverage for mouse-driven UI interactions: diff-pane text selection (drag-extend, double/triple-click word and line expansion, OSC52 clipboard copy and its unsupported-terminal fallback) and sidebar drag-resize plus the edit-selected-file action. Lifts `DiffPane.tsx` from 91% to 97% and `App.tsx` from 90% to 97% line coverage. Test-only; no user-visible change.
