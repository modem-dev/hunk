# hunk

Hunk is a review-first terminal diff viewer for agent-authored changesets, built on [OpenTUI](https://github.com/anomalyco/opentui) and [Pierre diffs](https://www.npmjs.com/package/@pierre/diffs).

**[hunk.dev](https://hunk.dev)** · [Documentation](https://hunk.dev/docs/)

[![CI status](https://img.shields.io/github/actions/workflow/status/modem-dev/hunk/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/modem-dev/hunk/actions/workflows/ci.yml?branch=main)
[![Latest release](https://img.shields.io/github/v/release/modem-dev/hunk?style=for-the-badge)](https://github.com/modem-dev/hunk/releases)
[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

- multi-file review stream with sidebar navigation
- inline AI and agent annotations beside the code
- split, stack, and responsive auto layouts
- watch mode for auto-reloading file and Git-backed reviews
- synchronized terminal and local browser review surfaces
- keyboard, mouse, pager, and Git difftool support

<table>
 <tr>
   <td width="60%" align="center">
    <img width="845" alt="image" src="https://github.com/user-attachments/assets/35605618-be3f-479e-b6e0-edb089910651" />
     <br />
     <sub>Split view with sidebar and inline AI notes</sub>
   </td>
   <td width="40%" align="center">
     <img width="507"alt="image" src="https://github.com/user-attachments/assets/92eb8993-f044-436d-a038-8139da5ad8de" />
     <br />
     <sub>Stacked view and mouse-selectable menus</sub>
   </td>
 </tr>
</table>

## Install

```bash
npm i -g hunkdiff
```

Or with Homebrew:

```bash
brew install hunk
```

> [!NOTE]
> If you previously installed hunk via `modem-dev/tap`, be sure to uninstall it first with `brew uninstall modem-dev/tap/hunk`.

Or with [mise](https://mise.jdx.dev) (macOS and Linux):

```bash
mise use -g hunk
```

Requirements:

- macOS, Linux, or Windows
- Node.js 18+ for the npm install; Homebrew, mise, and Nix ship a standalone binary
- Git recommended for most workflows

> Nix users can use the `default` package exported in `flake.nix` instead. See [nix/README.md](./nix/README.md) for details.

> Hunk also ships as a default tool in [Omarchy](https://omarchy.org), installed through mise.

## Quick start

```bash
hunk           # show help
hunk --version # print the installed version
```

### Working with Git

Hunk mirrors Git's diff-style commands, but opens the changeset in a review UI instead of plain text.

```bash
hunk diff                      # review current repo changes, including untracked files
hunk diff --watch              # auto-reload as the working tree changes
hunk show                      # review the latest commit
hunk show HEAD~1               # review an earlier commit
```

### Working with Jujutsu and Sapling

Hunk auto-detects Jujutsu and Sapling checkouts, so `hunk diff [revset]` and `hunk show [revset]` use native revsets inside jj or Sapling workspaces. To override VCS detection, set `vcs = "git"` or `vcs = "jj"` or `vcs = "sl"` in [config](#config).

### Working with raw files and patches

```bash
hunk diff before.ts after.ts                # compare two files directly
hunk diff before.ts after.ts --watch        # auto-reload when either file changes
git diff --no-color | hunk patch -          # review a patch from stdin
```

Watch mode remains continuous. Direct-file and Git-backed reviews normally use filesystem observation to refresh promptly, with periodic polling retained as a fallback for missed events or unavailable watchers. Jujutsu and Sapling reviews currently use polling rather than filesystem observation.

### Browser review

Add `--web` to any review command to use the synchronized browser surface instead of the terminal UI:

```bash
hunk diff --web
hunk diff --watch --web
hunk patch changes.patch --web --no-open
hunk diff --web --tailscale
hunk session open --repo .
hunk session open --repo . --tailscale --no-open
```

`--web` opens the default browser and keeps the owning Hunk process alive until `SIGINT` or `SIGTERM`; closing a tab does not stop a watched review. `--no-open` prints the capability URL without launching a browser. The URL grants access to that one live review, so treat it as a secret and do not share it.

Browser review is served by Hunk's loopback session daemon. Pass `--tailscale` to lazily add one browser-only listener on the machine's exact Tailscale IPv4 address; this requires the `tailscale` CLI to be installed and signed in. The resulting plain-HTTP URL is encrypted in transit by Tailscale/WireGuard, remains tailnet-only, and still requires the session capability. Broker websocket, health, and session API routes remain loopback-only. Unsafe remote daemon mode remains refused, and Hunk does not mutate `tailscale serve` configuration. If session brokering is disabled, omit `--web` to keep using the terminal UI.

Browser extension UI v1 includes host-rendered review data and semantic actions. OpenTUI sidebar components, terminal-only file views, and other renderer-specific extension components remain terminal-only; extension transforms and lifecycle hooks still run once in the owning review process for both surfaces.

### Working with agents

1. Open Hunk in another terminal with `hunk diff` or `hunk show`.
2. Tell your agent to add the skill file returned by `hunk skill path`.
3. Ask your agent to use the skill against the live Hunk session.

A good generic prompt is:

```text
Load the Hunk skill and use it for this review. Run `hunk skill path` to get the skill path.
```

For the full live-session and `--agent-context` workflow guide, see [docs/agent-workflows.md](docs/agent-workflows.md). Experimental rich STML note bodies require starting the review with `--experimental`; plain agent notes remain the default.

## Feature comparison

| Capability                         | [hunk](https://github.com/modem-dev/hunk) | [lumen](https://github.com/jnsahaj/lumen) | [difftastic](https://github.com/Wilfred/difftastic) | [delta](https://github.com/dandavison/delta) | [diff-so-fancy](https://github.com/so-fancy/diff-so-fancy) | [diff](https://www.gnu.org/software/diffutils/) |
| ---------------------------------- | ----------------------------------------- | ----------------------------------------- | --------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| Review-first interactive UI        | ✅                                        | ✅                                        | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Multi-file review stream + sidebar | ✅                                        | ✅                                        | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Inline agent / AI annotations      | ✅                                        | ❌                                        | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Responsive auto split/stack layout | ✅                                        | ❌                                        | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Mouse support inside the viewer    | ✅                                        | ✅                                        | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Runtime view toggles               | ✅                                        | ✅                                        | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Syntax highlighting                | ✅                                        | ✅                                        | ✅                                                  | ✅                                           | ❌                                                         | ❌                                              |
| Structural diffing                 | ❌                                        | ❌                                        | ✅                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Pager-compatible mode              | ✅                                        | ❌                                        | ✅                                                  | ✅                                           | ✅                                                         | ✅                                              |

Hunk is optimized for reviewing a full changeset interactively.

## Advanced

### Config

You can persist preferences to a config file:

- `~/.config/hunk/config.toml`
- `.hunk/config.toml`

Example:

```toml
theme = "github-dark-default" # any built-in theme id, auto, or custom
mode = "auto"        # auto, split, stack
vcs = "git"          # git, jj, sl
watch = false
exclude_untracked = false
line_numbers = true
tab_width = 4       # tab stops, 1-16
wrap_lines = false
menu_bar = true
agent_notes = false
prompt_save_view_preferences = true
transparent_background = false
```

Choose a built-in theme, `auto`, or a custom theme with `theme`. See
[docs/themes.md](docs/themes.md) for automatic selection, custom theme tables,
syntax scopes, and legacy syntax-table migration.

`exclude_untracked` affects Git/Sapling working-tree `hunk diff` sessions only.
`tab_width` controls source-code tab stops and can be overridden with `-x4` or `--tab-width 4`.
`prompt_save_view_preferences = false` disables the quit prompt for saving changed view preferences.
`transparent_background` can also be written as `transparentBackground`.

### Keybindings

Every keyboard shortcut is a named command, and a `[keybindings]` table in your
user config remaps command ids to the keys you want them on — several keys per
command, exclusive claims over defaults, and `false` to unbind. See
[docs/keybindings.md](docs/keybindings.md) for the rules, the chord grammar,
and the full table of built-in commands and their default keys.

### Git integration

Set Hunk as your Git pager so `git diff` and `git show` open in Hunk automatically:

> [!NOTE]
> Untracked files are auto-included only for Hunk's own `hunk diff` working-tree loader. If you open `git diff` through `hunk pager`, Git still decides the patch contents, so untracked files will not appear there.

```bash
git config --global core.pager "hunk pager"
```

Or in your Git config:

```ini
[core]
    pager = hunk pager
```

If you want to keep Git's default pager and add opt-in aliases instead:

```bash
git config --global alias.hdiff "-c core.pager=\"hunk pager\" diff"
git config --global alias.hshow "-c core.pager=\"hunk pager\" show"
```

### Jujutsu pager integration

To use Hunk as jj's pager, run `jj config edit --user` and update:

```toml
[ui]
pager = ["hunk", "pager"]
diff-formatter = ":git"
```

### Sapling pager integration

To use Hunk as Sapling's pager, run `sl config -u` and update:

```ini
[pager]
pager = hunk pager
```

### Extensions (experimental)

The extension API is experimental and may change in breaking ways between
minor releases while it stabilizes; breaking changes are called out in
release notes.

Hunk loads plain TypeScript extensions from `~/.config/hunk/extensions/`, from a
repository's `.hunk/extensions/` (after you explicitly trust that repository),
and from `--extension <path>` for development. `--no-extensions` turns those off
for one run; Hunk's own bundled backends (Git, Jujutsu, and Sapling) stay loaded.

A v1 extension can contribute themes and file-extension → language
mappings, add a VCS backend, rewrite the changeset before review (collapse
lockfiles, reorder files by review priority), replace the file-navigation
sidebar with its own React component, react to lifecycle events, and show
transient messages:

```ts
// ~/.config/hunk/extensions/collapse-lockfiles.ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.transformChangeset((changeset, ctx) => {
    const files = changeset.files.filter((file) => !file.path.endsWith(".lock"));
    ctx.notify(`Collapsed ${changeset.files.length - files.length} lockfiles`);
    return { ...changeset, files };
  });
}
```

Extensions shared as git repositories install straight from their host, and a
`hunk-extension` GitHub topic marks community ones:

```bash
hunk extension install acme/hunk-word-diff@v1.2.0   # or git:host/path, a URL, a local path
hunk extension list                                 # then update [name] / remove <name>
```

Browse community extensions at
[github.com/topics/hunk-extension](https://github.com/topics/hunk-extension);
publish yours by pushing the extension to a repository root and adding that
topic.

See [docs/extensions.md](docs/extensions.md) for the full API, the trust model,
publishing guidance, and the `[extensions]` / `[extension.<id>]` config reference.
Installable examples include [review triage](examples/extensions/review-triage/), an optional
[rendered Markdown file view](examples/extensions/rendered-markdown/), and a
[Vim navigation mode](examples/extensions/vim-navigation/) built from public semantic commands.

### OpenTUI component

Hunk also publishes `HunkDiffView` and lower-level primitives from `hunkdiff/opentui` for embedding the same diff renderer in your own OpenTUI app.

See [docs/opentui-component.md](docs/opentui-component.md) for install, API, and runnable examples.

## Examples

Ready-to-run demo diffs live in [`examples/`](examples/README.md).

Each example includes the exact command to run from the repository root.

## Contributing

💬 _Chat with users/contributors on the [Modem Discord server](https://discord.gg/WZFjaP6Gt8)_

For source setup, tests, packaging checks, and repo architecture, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Sponsor

Sponsored by [Modem](https://modem.dev?utm_source=github&utm_medium=oss&utm_campaign=oss_hunk&utm_content=readme_footer).

<a href="https://modem.dev?utm_source=github&utm_medium=oss&utm_campaign=oss_hunk&utm_content=readme_footer">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://modem.dev/images/logo/svg/modem-combined-white.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://modem.dev/images/logo/svg/modem-combined-black.svg">
    <img src="https://modem.dev/images/logo/svg/modem-combined-black.svg" alt="Modem" width="220">
  </picture>
</a>

## License

[MIT](LICENSE)
