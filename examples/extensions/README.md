# Extension examples

Ready-to-run, opt-in examples for Hunk's experimental TypeScript extension API. None of these folders are bundled or loaded automatically.

| Example                                            | What it demonstrates                                                                                                                       | Best starting point for                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| [`review-triage/`](review-triage/)                 | A session-local hunk review board built from a React sidebar, commands, dialogs, navigation, lifecycle events, and the extension event bus | Stateful review workflows and custom sidebars     |
| [`rendered-markdown/`](rendered-markdown/)         | A parsed Markdown presentation using symbolic rows, exact-source bindings, inline notes, and raw-diff fallback                             | Host-rendered file previews                       |
| [`jsx-file-view/`](jsx-file-view/)                 | The smallest fixed-height React/OpenTUI file-view proof of concept, including hooks, semantic theme props, and row fallback                | Custom JSX rows                                   |
| [`jsx-file-view-gallery/`](jsx-file-view-gallery/) | TypeScript change-atlas cards, CSS color swatches, dependency-version deltas, and a mixed raw/custom five-file review                      | Realistic file-view layouts and fallback behavior |

Each folder has its own README with an exact command and notes on the API contract it exercises. Run an example directly from this checkout with `--extension` while developing. To install one, copy its complete folder into `~/.config/hunk/extensions/` and install any dependency its `package.json` declares.

## Reference implementations

Hunk also exercises the public API in its bundled extensions:

- [`src/extensions/default/ui/sidebar/`](../../src/extensions/default/ui/sidebar/) implements Hunk's built-in file navigation as a registered React sidebar.
- [`src/extensions/default/vcs/`](../../src/extensions/default/vcs/) implements the Git, Jujutsu, and Sapling backends as registered VCS adapters.

These are production reference implementations rather than installable examples. They remain loaded when user extensions are disabled.

## Learn the API

Start with the [extension authoring guide](../../docs/extensions.md), then use the focused website guides for [custom sidebars](https://hunkdiff.dev/docs/extend/custom-sidebars/), [file previews](https://hunkdiff.dev/docs/extend/file-previews/), and [VCS adapters](https://hunkdiff.dev/docs/extend/vcs-adapters/).
