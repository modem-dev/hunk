# Extension API field notes: Review triage

`examples/extensions/review-triage/` is a deliberately ordinary, user-installable extension built only against `hunkdiff/extension`. It provides a session-local hunk triage board: a reviewer can open a right sidebar, navigate through public hunk summaries, mark the current hunk approved/investigate/blocked with an optional rationale, and clear decisions. Its commands are ordinary **Extensions** menu entries, while lifecycle and bus events keep the board current.

Building it validated the API's central path: a third-party extension can compose a React sidebar, menu-reachable commands, host-owned modal dialogs, selection snapshots, lifecycle subscriptions, notifications, and a small inter-extension bus without imports from Hunk internals. The PTY integration test loads this exact directory rather than a string fixture.

## Findings

### Sidebar geometry and selection following are missing

The public sidebar props expose width but not pane height, viewport bounds, scroll position, or a way to scroll an item into view. The bundled file sidebar uses host-internal `ScrollBoxRenderable` viewport events and `scrollChildIntoView`; a third-party sidebar cannot reproduce its windowing or follow-selection behavior. Review triage therefore uses a simple scrollbox and compact rows, but selected hunks can fall out of view for a large review.

**Suggested addition:** expose read-only pane viewport geometry plus a narrow `actions.scrollItemIntoView(id)` capability (or a supported scrollbox ref contract). This would let extensions virtualize and retain selection visibility without exposing OpenTUI internals.

### Extensions have no safe, host-managed persistence

The triage board can only be session-local. Extension config is repository-overridable and expressly untrusted for exec-adjacent decisions; using it as writable storage would be wrong. Writing an arbitrary file from the extension is possible but creates incompatible location, lifecycle, privacy, and cleanup policies for every author. Reloading can also change a file id or hunk index, so blindly persisting the current key would misapply decisions.

**Suggested addition:** a namespaced, user-owned storage API with explicit scopes such as session and local-user/repository, plus a changeset identity available for reconciliation. Hunk should own the file location and trust semantics.

### Command handlers cannot navigate the review stream

Commands receive a selection snapshot, dialogs, and sidebar open/close controls, but no `selectFile` or `selectHunk`. A "next blocked hunk" command therefore cannot navigate directly; it would need to rely on a mounted sidebar to perform navigation, which is both indirect and unreliable on a narrow terminal. Review triage avoids shipping that misleading command and makes hunk rows clickable instead.

**Suggested addition:** place the existing guarded `selectFile` / `selectHunk` navigation methods on command context as well as sidebar actions.

### Dialogs are intentionally simple, but triage exposes their limits

The select/input sequence works well for a short status and single-line rationale. There is no structured option value (only displayed strings), validation hook, multiline input, or way to retain a dialog target if the session reloads; reload cancellation is safe and correct, but an extension has to design around it.

**Suggested addition:** retain the current simple primitives, then consider labelled `{ value, label }` select choices and a multiline input primitive. Dialog requests should still cancel on reload rather than acting on stale review state.

### The Extensions menu is command-generated, not extensible layout

Commands make the extension visible in the Extensions menu and are sufficient for this workflow. But they cannot add a custom submenu, separator, checked state, disabled state, or an entry elsewhere in the menu bar. This is an appropriate initial boundary, but it means command titles must carry more UI work than a purpose-built menu model.

**Suggested addition:** no change is required yet. If richer menu integration is added, model it as declarative command state rather than arbitrary extension renderables in chrome.

## Non-gaps confirmed by the extension

- A React component loaded from disk can render in Hunk's tree and use hooks when it imports the host-served `react` module.
- The public hunk summaries and sidebar selection/index contract are sufficient to render and drive a hunk-level board without accessing opaque diff metadata.
- `useSyncExternalStore` is a viable bridge from detached lifecycle callbacks to sidebar rendering, including while the sidebar is closed.
- Host-rendered dialogs provide appropriate attribution and modal behavior; command registrations provide menu and keyboard access through one mechanism.
- Lifecycle events and the namespaced bus are sufficient for session-local, fire-and-forget coordination, as long as the extension treats them as observers rather than persistence or request/response channels.
