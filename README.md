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

Full documentation, including guides and generated CLI/config references, lives at **[hunk.dev/docs](https://hunk.dev/docs/)**.

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

- Node.js 18+ (npm installs; Homebrew and Nix binaries are self-contained)
- macOS, Linux, or Windows
- Git recommended for most workflows

> Nix users can use the `default` package exported in `flake.nix` instead. See [nix/README.md](./nix/README.md) for details.

## Quick start

```bash
hunk           # show help
hunk --version # print the installed version
```

### Review Git changes

Hunk mirrors Git's diff-style commands, but opens the changeset in a review UI instead of plain text.

```bash
hunk diff                    # working tree changes, untracked files included
hunk diff --staged           # staged changes only
hunk diff main...feature     # compare against a target
hunk show                    # the latest commit
hunk show HEAD~1             # an earlier commit
hunk stash show              # a stash entry
```

Add `--watch` to auto-reload as the input changes, and `--exclude-untracked` when you want tracked changes only. Arguments after `--` are pathspecs, as in `hunk show HEAD~1 -- src/ui`.

### Review in Jujutsu and Sapling

Hunk auto-detects Jujutsu and Sapling checkouts, so `hunk diff [revset]` and `hunk show [revset]` use native revsets inside jj or Sapling workspaces. To override VCS detection, set `vcs = "git"` or `vcs = "jj"` or `vcs = "sl"` in [config](#configuration).

### Review files and patches

```bash
hunk diff before.ts after.ts         # compare two files directly
hunk patch change.patch              # review a patch file
git diff --no-color | hunk patch -   # review a patch from stdin
```

`--watch` works with any input Hunk can reopen — direct files, repositories, and patch files, but not stdin snapshots.

### Review with an agent

1. Open Hunk in one terminal with `hunk diff` or `hunk show`.
2. Tell your agent to add the skill file returned by `hunk skill path`.
3. Ask your agent to use the skill against the live Hunk session:

```text
Load the Hunk skill and use it for this review. Run `hunk skill path` to get the skill path.
```

You keep the TUI; the agent inspects and steers the same live review through `hunk session` commands and leaves inline notes beside the code. See [docs/agent-workflows.md](docs/agent-workflows.md) for the full workflow, including prewritten `--agent-context` note sidecars and experimental STML markup.

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

## Integrations

### Git pager

Set Hunk as your Git pager so `git diff` and `git show` open in Hunk automatically:

```bash
git config --global core.pager "hunk pager"
```

If you want to keep Git's default pager and add opt-in aliases instead:

```bash
git config --global alias.hdiff "-c core.pager=\"hunk pager\" diff"
git config --global alias.hshow "-c core.pager=\"hunk pager\" show"
```

> [!NOTE]
> In pager mode Git decides the patch contents, so untracked files will not appear there. Only Hunk's own `hunk diff` working-tree loader auto-includes them.

### Git difftool

To use Hunk as an explicit `git difftool`:

```bash
git config --global diff.tool hunk
git config --global difftool.hunk.cmd 'hunk difftool "$LOCAL" "$REMOTE" "$MERGED"'
git config --global difftool.prompt false
```

Git invokes the difftool once per file pair; prefer `hunk diff` when you want the full-changeset review stream.

### Jujutsu pager

To use Hunk as jj's pager, run `jj config edit --user` and update:

```toml
[ui]
pager = ["hunk", "pager"]
diff-formatter = ":git"
```

### Sapling pager

To use Hunk as Sapling's pager, run `sl config -u` and update:

```ini
[pager]
pager = hunk pager
```

## Configuration

You can persist preferences to a config file:

- `~/.config/hunk/config.toml`
- `.hunk/config.toml` (repository-local, overrides user settings)

Example:

```toml
theme = "github-dark-default" # any built-in theme id, auto, or custom
mode = "auto"                 # auto, split, stack
vcs = "git"                   # git, jj, sl
watch = false
exclude_untracked = false     # Git/Sapling working-tree reviews only
line_numbers = true
tab_width = 4                 # tab stops, 1-16; also -x4 / --tab-width 4
wrap_lines = false
hunk_headers = true
menu_bar = true
agent_notes = false
prompt_save_view_preferences = true # offer to save view changes on quit
transparent_background = false
```

See [docs/themes.md](docs/themes.md) for automatic theme selection, custom theme tables, and syntax scopes, and the [config reference](https://hunk.dev/docs/reference/config/) for every key, default, alias, and per-command `[section]` scoping.

### Keybindings

Every keyboard shortcut is a named command, and a `[keybindings]` table in your user config remaps command ids to the keys you want them on — several keys per command, exclusive claims over defaults, and `false` to unbind. See [docs/keybindings.md](docs/keybindings.md) for the rules, the chord grammar, and the full table of built-in commands and their default keys.

### Extensions (experimental)

The extension API is experimental and may change in breaking ways between minor releases while it stabilizes; breaking changes are called out in release notes.

Hunk loads plain TypeScript extensions from `~/.config/hunk/extensions/`, from a repository's `.hunk/extensions/` (after you explicitly trust that repository), and from `--extension <path>` for development. `--no-extensions` turns those off for one run; Hunk's own bundled backends (Git, Jujutsu, and Sapling) stay loaded.

An extension can contribute themes and file-extension → language mappings, add a VCS backend, rewrite the changeset before review (collapse lockfiles, reorder files by review priority), replace the file-navigation sidebar with its own React component, react to lifecycle events, and show transient messages:

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

See [docs/extensions.md](docs/extensions.md) for the full API, the trust model, and the `[extensions]` / `[extension.<id>]` config reference.

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
