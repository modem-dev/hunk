# hunk

Hunk is a review-first terminal diff viewer for agent-authored changesets, built on [OpenTUI](https://github.com/anomalyco/opentui) and [Pierre diffs](https://www.npmjs.com/package/@pierre/diffs).

[![CI status](https://img.shields.io/github/actions/workflow/status/modem-dev/hunk/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/modem-dev/hunk/actions/workflows/ci.yml?branch=main)
[![Latest release](https://img.shields.io/github/v/release/modem-dev/hunk?style=for-the-badge)](https://github.com/modem-dev/hunk/releases)
[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

- multi-file review stream with sidebar navigation
- inline AI and agent annotations beside the code
- split, stack, and responsive auto layouts
- watch mode for auto-reloading file and Git-backed reviews
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

Requirements:

- Node.js 18+
- macOS, Linux, or Windows
- Git recommended for most workflows

> Nix users can use the `default` package exported in `flake.nix` instead. See [nix/README.md](./nix/README.md) for details.

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

### Working with agents

1. Open Hunk in another terminal with `hunk diff` or `hunk show`.
2. Tell your agent to add the skill file returned by `hunk skill path`.
3. Ask your agent to use the skill against the live Hunk session.

A good generic prompt is:

```text
Load the Hunk skill and use it for this review. Run `hunk skill path` to get the skill path.
```

For the full live-session and `--agent-context` workflow guide, see [docs/agent-workflows.md](docs/agent-workflows.md).

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

`theme = "auto"` and `--theme auto` query the terminal background at startup, choose `github-light-default` for light backgrounds and `github-dark-default` for dark backgrounds, and fall back to `github-dark-default` if the terminal does not answer.
Older theme ids such as `graphite` and `paper` remain accepted as compatibility aliases.
`exclude_untracked` affects Git/Sapling working-tree `hunk diff` sessions only.
`tab_width` controls source-code tab stops and can be overridden with `-x4` or `--tab-width 4`.
`prompt_save_view_preferences = false` disables the quit prompt for saving changed view preferences.
`transparent_background` can also be written as `transparentBackground`.

Custom themes can inherit from any built-in theme and override only the colors you care about:

```toml
theme = "custom"

[custom_theme]
base = "catppuccin-mocha"
label = "My Theme"
accent = "#7fd1ff"
panel = "#10161d"
noteBorder = "#c49bff"

[custom_theme.syntax_scopes]
"comment" = "#6e85a7"
"punctuation.definition.comment" = "#6e85a7"
"keyword.operator" = "#7fd1ff"
"entity.name.function" = "#8ed4ff"
```

`syntax_scopes` uses [Shiki/TextMate scope selectors](https://shiki.style/guide/themes#token-colors) directly, so matching and precedence follow Shiki's theme rules without a Hunk-specific translation layer. Quote selectors containing dots. Declaration order is preserved; later rules win when matching selectors have equal specificity, while a more-specific base-theme selector beats a broader override. Add the grammar-specific selector when that happens. All custom theme colors must use `#rrggbb` hex values.

The former `[custom_theme.syntax]` role table is deprecated but temporarily translated into approximate scopes for compatibility. Both tables can coexist while migrating, and an exact `syntax_scopes` entry overrides a translated entry with the same selector. Because semantic roles have no one-to-one TextMate mapping, migrate when practical: for example, replace `comment = "#ffffff"` with both `"comment" = "#ffffff"` and `"punctuation.definition.comment" = "#ffffff"` under `[custom_theme.syntax_scopes]`, adding language-specific selectors when a grammar uses more specific scopes. The compatibility table will be removed in the next major release.

Press `t` in the app, or choose `View -> Themes…`, to open the theme selector.

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
