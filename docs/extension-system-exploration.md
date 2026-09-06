# Hunk extensions: an exploration

What a JavaScript/TypeScript extension system for Hunk could look like, modeled
on the extension system of [pi](https://pi.dev) (`@earendil-works/pi`), grounded
in Hunk's actual architecture. This is a design exploration, not a spec.

## 1. How pi does it

pi is a terminal coding agent whose stated philosophy is "adapt pi to your
workflow without forking it". Its extension system is the main mechanism for
that, and it has produced a real ecosystem (LSP integration, plan mode,
subagents, usage dashboards, statuslines, git-worktree management, browser
automation, even minigames that run while tests execute).

The mechanics that matter for us:

- **An extension is one TS file (or folder) exporting a default factory:**

  ```ts
  export default function (pi: ExtensionAPI) {
    pi.registerCommand("recap", { run: async (ctx) => { ... } });
    pi.registerShortcut("ctrl+g", { run: ... });
    pi.on("turn_end", async (event, ctx) => { ... });
  }
  ```

  No manifest, no build step. The runtime executes TS directly.

- **Auto-discovery from trusted locations:** `~/.pi/agent/extensions/*.ts`
  (global) and `.pi/extensions/*.ts` (project-local, loaded only after the
  project is explicitly trusted). Additional sources via settings:
  `"packages": ["npm:@foo/bar@1.0.0", "git:github.com/user/repo@v1"]`, plus a
  `-e ./path.ts` flag for development and `/reload` for hot reload.

- **One capability-granting API object**, not global hooks. Everything an
  extension can do goes through `ExtensionAPI` / `ExtensionContext`:
  registration (`registerCommand`, `registerShortcut`, `registerTool`,
  `registerFlag`, renderers), lifecycle + pipeline events (`session_start`,
  `turn_start/end`, `tool_call` with block/mutate power, `context` filtering,
  `input` interception), UI services (`ctx.ui.select/confirm/input/notify`,
  status bar slots, widgets, custom footers, autocomplete providers), and a
  shared event bus for extension-to-extension communication.

- **Events are interception points, not just notifications.** `tool_call` can
  block or rewrite a tool invocation; `message_end` can replace a message;
  `input` can consume user input entirely. This is what lets extensions change
  _behavior_, not just decorate it.

- **Packages bundle extensions + skills + prompts + themes** and are installed
  with `pi install`. Notably, Hunk already participates in this ecosystem from
  the other side: our `package.json` declares `"pi": { "skills": ["./skills"] }`
  so pi users get the `hunk-review` skill automatically.

## 2. Why this fits Hunk

Hunk's positioning — "modern desktop diff tool in a terminal", review-first,
agent-adjacent — means users live in it during review and want it wired into
_their_ workflow: their editor, their forge, their VCS, their team's review
conventions, their agent. We cannot build all of that in core, and shouldn't.
The pi lesson is that a small, well-chosen API surface plus "coding agents make
writing plugins cheap" yields an ecosystem: most pi extensions are clearly
agent-written from a README and an afternoon.

The same force works for us twice over: agents can write Hunk extensions, and
Hunk is _used to review agent changesets_, so extensions that connect review to
agent workflows (post a comment back to the agent session, re-run the agent on
a rejected hunk) are the most natural third-party contributions imaginable.

## 3. Example extensions (use-case catalog)

Roughly ordered from "certain someone builds this in week one" to speculative:

- **Open-in-X**: a key that opens the selected hunk in `$EDITOR`, VS Code,
  IntelliJ, or a browser at the forge URL. (Core has one editor action today;
  everyone's variant differs.)
- **Copy-as**: copy the selected hunk as a fenced patch, a GitHub-suggestion
  block, or a permalink, ready to paste into a PR comment or Slack.
- **Forge review bridge**: publish accumulated review notes as a GitHub /
  GitLab / Gerrit review from inside Hunk; show existing PR review threads as
  notes beside the hunks they target.
- **Send-to-agent**: a shortcut that packages the selected hunk plus your draft
  note and sends it to a running pi / Claude Code session ("fix this"), using
  the daemon the same way `hunk session comment` does — in reverse.
- **Changeset transforms**: auto-collapse lockfiles and generated files,
  reorder files by review priority, hide vendored dirs — per-team policy as a
  10-line extension instead of N config flags.
- **Note templates / conventional comments**: `nit:`, `blocking:`, `praise:`
  prefixes with severity colors; team review checklists rendered as a note.
- **Extra VCS backends**: Mercurial, Fossil, Perforce — the `VcsAdapter`
  interface already exists; an extension just registers another one.
- **Context enrichment**: show `git blame` age, CODEOWNERS, CI status, or the
  Linear ticket for the branch in the file header; LSP hover for the symbol
  under the selected line.
- **Explain-this-hunk**: call the user's own model API key to annotate a hunk
  on demand, rendering the answer as an agent note (STML makes these render
  well).
- **Theme + language packs**: ship N custom themes and file-extension →
  language mappings as an installable package.
- **Review metrics**: time-per-file, notes-per-changeset dashboards; export a
  review session as a markdown report.

## 4. What Hunk already has (integration-surface audit)

An audit of the codebase found no intentional plugin mechanism, but several
seams in very different states of readiness:

**Nearly plugin-shaped already:**

- `vcsAdapters` (`packages/hunk/src/core/vcs/index.ts`) — a real adapter pattern: detection,
  per-operation handler maps, capability probing. Making the array appendable
  is almost the whole job for third-party VCS support.
- The session broker (`packages/session-broker*`) is generic over session
  info/state/message types by design, and the app installs its command
  dispatcher at runtime via `createHunkSessionBridge(handlers)` +
  `hostClient.setBridge(...)` (`packages/hunk/src/app/session/bridge.ts`). That bridge is
  the single clearest injection point for extension-provided session commands.
- Dynamic theme registration exists (`ensureSyntaxHighlightThemeRegistered` →
  Pierre's `registerCustomTheme`), but the config layer caps custom themes at
  one `"custom"` slot.
- Pierre's `setCustomExtension` (`packages/hunk/src/core/changeset/fileLanguage.ts`) is already used at
  import time for `.mts`/`.cts`; extending it to plugin-declared mappings is
  trivial.
- `StartupDeps` (`packages/hunk/src/app/startup.ts`) fully injects the startup pipeline
  (currently only tests use it), and unknown TOML keys are silently ignored, so
  an `[extensions]` config section is backward-compatible on day one.

**The gaps:**

- **No action registry.** Keyboard handling is a 650-line if/else ladder over
  `key.name` (`useAppKeyboardShortcuts.ts`); the same ~30 actions are
  re-enumerated as callback props there, in `buildAppMenus`, and in a
  hardcoded `HelpDialog` sections array. Extensions can't contribute a command
  or a keybinding because _core_ has no named-command concept to contribute to.
- **Generic CLI dispatch now has an extension fallback.** Built-ins still win
  through `parseCli`'s closed fast path, while an unknown top-level token loads
  enabled/trusted extensions and resolves `registerCliCommand` registrations.
  Handlers own raw nested args and leased I/O, and may exit or delegate once to
  a built-in plan without rerunning an unchanged factory prefix. Bare help stays
  static; unloaded command discovery remains a future manifest/listing problem.
- **Session actions take five files in lockstep** (`protocol.ts` union +
  version bump, `brokerServer.ts` switch + supported-actions list, `bridge.ts`,
  session `cli.ts`, `core/cli.ts` parser). A registry keyed by action name
  would collapse that — and is a prerequisite for extension session commands.
- **`MenuId` is a closed union**, though menu _entries_ are already data-shaped
  (`{label, hint, checked, action}`), so contribution points are cheap once
  actions exist.
- **No dynamic user-code loading anywhere**, and Hunk ships as a compiled Bun
  binary — see the open question below.

## 5. Proposed shape

Mirror pi's model closely; it is proven and our users overlap with pi's.

### Extension form and discovery

````ts
// ~/.config/hunk/extensions/copy-as-suggestion.ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.registerAction({
    id: "copy-as-suggestion",
    label: "Copy as GitHub suggestion",
    keys: ["ctrl+shift+c"],
    menu: "file",
    when: (ctx) => ctx.selection.hunk !== null,
    run: async (ctx) => {
      const patch = ctx.selection.hunkPatchText();
      await ctx.clipboard.write("```suggestion\n" + patch + "\n```");
      ctx.ui.notify("Copied as suggestion");
    },
  });
}
````

- Discovery: `~/.config/hunk/extensions/*.ts` and `*/index.ts` (global, follows
  our existing XDG path logic in `packages/hunk/src/core/run/paths.ts`), `.hunk/extensions/`
  (repo-local, **trust-gated**, same posture as pi's project trust), explicit
  `[extensions] paths = [...]` in `config.toml`, and a `--extension <path>`
  dev flag. `--no-extensions` for a clean run and for bug triage.
- Per-extension config lives in the extension's own TOML table
  (`[extension.copy-as-suggestion]`), read through the existing layering engine
  so repo config can override user config exactly like core options.

### API surface, grouped by the seam it rides on

| Capability                                                                                                                          | Backed by                                                                         | Refactor needed                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `registerAction({id, label, keys, menu, when, run})`                                                                                | new action registry feeding keyboard hook, `buildAppMenus`, `HelpDialog`          | the big one — see below                                           |
| `on(event, handler)` — `startup`, `changeset_loaded`, `selection_changed`, `note_added`, `note_saved`, `session_reload`, `shutdown` | emit from `AppHost` / `useReviewController` mutators                              | small                                                             |
| `transformChangeset(fn)`                                                                                                            | run after `loadAppBootstrap`, before first render, in `AppHost.reloadSession` too | small; must preserve sidecar ordering contract                    |
| `registerVcsAdapter(adapter)`                                                                                                       | `vcsAdapters` array                                                               | trivial                                                           |
| `registerTheme(theme)`                                                                                                              | generalize the single `"custom"` slot to N; Shiki side already dynamic            | small                                                             |
| `registerFileLanguage(ext, lang)`                                                                                                   | Pierre `setCustomExtension`                                                       | trivial                                                           |
| `registerSessionCommand(name, parse, handler)`                                                                                      | bridge dispatcher + broker action registry                                        | medium; collapses the 5-file lockstep first                       |
| `registerCliCommand(...)`                                                                                                           | command table replacing `parseCli` switch + help generation                       | medium; defer                                                     |
| `ctx.review` (read + navigate: files, selection, notes, `navigateTo`)                                                               | thin façade over `ReviewController`                                               | small, but must stay a façade — never hand out the raw controller |
| `ctx.ui.confirm/select/input/notify`                                                                                                | reuse `ConfirmDialog` + a toast/status line                                       | small                                                             |
| `ctx.exec`, `ctx.clipboard`, `ctx.cwd`, `ctx.changeset`                                                                             | plumbing                                                                          | small                                                             |

Two pi ideas worth copying verbatim: the **`ctx` object passed to every
handler** (capability access is explicit and testable, and there's no global to
monkey-patch), and **events that can intercept, not just observe** — e.g. a
`note_saving` event that can rewrite a note body is what makes conventional-
comment templates possible without core knowing about them.

Two pi ideas to _skip_ for now: provider/model registration (not our domain)
and custom message renderers (our equivalent — custom note renderables — fights
the STML deterministic-layout rule; extensions should emit STML markup instead,
which keeps measurement exact and theme-independent by construction).

### The enabling refactor: a named-action registry

Every UI-facing capability above lands on the same prerequisite: core actions
become data (`{id, label, hint, keys, menuId, isAvailable, run}`) in one
registry that `useAppKeyboardShortcuts`, `buildAppMenus`, and `HelpDialog` all
derive from. This is worth doing even if extensions never ship — it deletes the
existing triplication and the 650-line key ladder — and it is exactly the
"single source of truth per user-visible behavior" rule in our own guidance.
User keybinding remapping (a long-standing wish in tools like this) falls out
of the same structure for free.

## 6. Suggested phasing

1. **Phase 0 — loader spike.** Prove that a compiled `bun build --compile`
   binary can `import()` user TS from disk (see open questions). Build the
   extension host: discovery, trust prompt for repo-local, error isolation
   (one broken extension logs a startup notice — the existing
   `startupNotices` channel — and is skipped, never crashes review),
   `--no-extensions`.
2. **Phase 1 — cheap registrations.** Themes (N custom), file languages, VCS
   adapters, `transformChangeset`, lifecycle events, `ctx.ui.notify`. No UI
   contribution yet; already enough for theme packs, lockfile-collapsing, and
   a Mercurial adapter.
3. **Phase 2 — the action registry.** Refactor core actions, then open
   `registerAction` with keys + menu + help integration, `ctx.review` façade,
   `ctx.ui` prompts. This unlocks the whole open-in-X / copy-as / send-to-agent
   family — the highest-demand tier.
4. **Phase 3 — protocol surfaces.** Session-command registry (after collapsing
   the 5-file lockstep), then CLI command table. Extension session commands
   need a capability story in the daemon handshake so `hunk session <ext-cmd>`
   fails cleanly against a session that lacks the extension.
5. **Phase 4 — distribution.** `hunk install npm:...` package support,
   hot-reload for extension development, and a docs page whose real audience is
   coding agents (pi ships an `extending-pi` guidance extension; our equivalent
   is a `hunk-extension-authoring` skill — same trick we already use for
   `hunk-review`).

## 7. Open questions

- **Compiled-binary loading.** The installed `hunk` is a `bun build --compile`
  snapshot. Runtime `import()` of arbitrary on-disk TS from a compiled binary
  is the load-bearing assumption behind "one TS file, no build step" — it must
  be spiked first. Fallbacks if it fails: transpile with `Bun.Transpiler` and
  evaluate, or require plain `.js`/`.mjs` for the binary while `bun run` keeps
  full TS. This decides Phase 0.
- **Security posture.** Extensions run with full user permissions (same as pi;
  same as any dotfile). The trust gate for repo-local extensions is the
  critical piece — reviewing a hostile repo's changeset must never execute
  that repo's code without an explicit prompt. This matters _more_ for Hunk
  than for pi: pointing a diff tool at untrusted code is a core use case.
- **API stability.** pi treats extension API churn as acceptable pre-1.0. We
  should version the API (`hunk.apiVersion`) from day one, and keep the
  surface minimal — everything in the table above is a façade we control, not
  a leaked internal type. Pierre types (`FileDiffMetadata`) should not appear
  in the extension API.
- **Windows.** Discovery paths and `ctx.exec` must stay portable per our
  cross-platform rules; nothing here is inherently Unix-only.
- **Does the OpenTUI embedding API make some of this moot?** `hunkdiff/opentui`
  already offers "extension by embedding" for people building their own review
  UIs. The answer is no — embedding serves builders of _other tools_;
  extensions serve users of _Hunk_. But the two should share the same façade
  types where they overlap.

## 8. Bottom line

The pi model transplants well. Hunk's architecture is closer to extension-ready
than expected in three places (VCS adapters, the session bridge, theme
registration) and blocked in one structural place (no named-action registry —
a refactor that is independently justified). The recommended path is the
phasing above, with the compiled-binary loader spike as the gating first step.
