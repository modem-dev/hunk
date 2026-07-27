---
"hunkdiff": minor
---

Extensions can replace the file-navigation sidebar with their own React component via `hunk.registerSidebarView`. Extension files now receive Hunk's own React (and `hunkdiff/extension` runtime values) when imported, so hooks and JSX work without bundling anything; the component gets live props (visible files, selection, theme tokens) plus actions that drive review navigation exactly like the built-in sidebar, and a component that fails to render falls back to the built-in sidebar with a warning instead of taking down the session.
