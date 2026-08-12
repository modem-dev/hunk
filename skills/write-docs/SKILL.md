---
name: write-docs
description: Teaches Hunk's documentation house style and structure rules. Use whenever creating, editing, restructuring, or reviewing any Hunk documentation — pages under website/src/content/docs/, the README, repo docs/*.md, changelog entries, or docs-heavy PR text. Also use when asked to document a feature, write a guide, improve docs wording, or check docs for AI-sounding prose, even when the request does not say "docs".
---

# Writing Hunk docs

Rules for documentation that reads like it was written by a careful human who
knows the product. The one-sentence version: **say true, specific things in
short declarative sentences, structure pages around the reader's situation,
and delete every word that exists to impress rather than inform.**

## Where docs live

| Location | Audience | Notes |
| --- | --- | --- |
| `website/src/content/docs/docs/` | Users | The hunk.dev docs site (Starlight). Sidebar order lives in `website/astro.config.mjs`. |
| `website/src/content/docs/docs/reference/cli.md`, `config.md` | Users | **Generated** by `bun run generate:docs`. Never hand-edit; change the runtime metadata sources. |
| `skills/hunk-review/SKILL.md` | Agents | **Generated** by `bun run generate:skill`. Never hand-edit. |
| `docs/*.md` (repo root) | Contributors | Internal architecture and process notes. Do not link them from the user docs nav. |
| `README.md` | Both | A condensed pitch plus pointers, not a second manual. |

Every docs-site page is also served as raw Markdown (`<url>.md`) and bundled
into `/llms.txt` corpora for agents. Write pages that read cleanly as plain
Markdown: no custom components carrying meaning, tables that make sense
unrendered, code blocks with language tags.

## Structure: pages

**One page, one job — stated immediately.** Open with a sentence that says
what the page covers and, when a sibling page could overlap, where the other
topic lives: "This page covers day-to-day review details that do not fit on
the quick start." That sentence prevents both duplication and reader doubt.
If it cannot be written, the page's scope is wrong.

**Frontmatter description is a real summary.** It appears in link cards,
search, and the llms.txt index. Write what the page lets the reader do
("Diagnose missing input, session access, terminal behavior, and
configuration problems"), never a restated title.

**Order sections by reader commitment, not feature taxonomy.** The first
screen serves someone five minutes in; completeness lives further down or in
the reference. Teach the five keys that carry a review before the full
keybinding table. Show the two-line config most people want before the
exhaustive options.

**When behavior varies by scenario, lead with a matrix.** Scenarios as rows,
guarantees as columns, then one section elaborating each row. Use this shape
for anything like "which input modes support watch" or "what each terminal
supports". The table answers the question; the sections explain it. Nothing
gets explained twice.

**End with an exit.** Guide pages close with two to four annotated next links
("[Live session control](…) — target, navigate, and reload a review from the
CLI"). Pages that compare paths close with a short "Which to use" decision:
one sentence per path, naming the situation that picks it.

**Troubleshooting entries are symptom-titled pointers.** The heading is what
the user sees ("Watch mode is rejected"), the body is cause → exact fix →
link to the section that owns the full explanation. Troubleshooting owns the
symptom-to-answer mapping, never the deep explanation — that lives on the
feature's page, where it stays current.

### New page skeleton

```markdown
---
title: <Noun phrase, not a sentence>
description: <What the page lets the reader do, one sentence.>
---

<What this page covers, and where the adjacent topic lives.>

## <First thing a newcomer needs>

<Command or config first, then one sentence explaining any non-obvious flag.>

## <Deeper sections in decreasing order of reader commitment>

## <Exit: 2–4 annotated links, or a "Which to use" decision>
```

## Structure: the docs as a whole

- Groups follow the adoption journey: start → use → configure → extend →
  reference → help. A new page joins the group whose reader needs it, not the
  group matching its implementation.
- Each sidebar group opens with a page that orients ("here are the paths,
  here is which to pick") before pages that go deep on one path.
- Define each product noun (review stream, hunk, session, note, changeset) on
  one page and link to it. Re-explaining a term inline means the explanation
  should become a link.
- Guides and generated references have a contract: guides carry recipes,
  reasoning, and anything needing more room than a reference row; the
  reference carries every key, flag, and default. Guides delegate ("see the
  [config reference](/docs/reference/config/)") instead of copying values —
  a hand-copied default goes stale silently.
- Moving or renaming a page changes its URL. Add a redirect and keep old
  links working; prefer names and groups that can last.
- Keep audiences pure: deployment runbooks, benchmark notes, and architecture
  explorations belong in repo `docs/`, not in the user-facing nav.

## Language

Hunk's existing docs are the register to match: technical, economical, a
little dry. Before writing, read two existing pages and match them.

- **Short declarative sentences, present tense, active voice.** The subject
  is Hunk, the command, or the reader. "Hunk reloads file-backed input."
  "Press `]` to jump to the next hunk." A sentence with two commas and an
  "and" usually wants to be two sentences.
- **Frame before mechanics.** A guide section opens with one plain sentence
  saying what the feature is for; the command comes second. "Watch mode keeps
  the review in sync with the working tree:" then the code block. Facts
  without a frame read like a changelog.
- **Connect the sentences.** Carry cause and consequence with "as", "so",
  "instead of", "which means". "As the files change, Hunk reloads the input
  and preserves your place in the stream." Three isolated declaratives in a
  row is a reference entry, not a guide — save that register for reference
  pages and troubleshooting entries, where it belongs.
- **Vary the rhythm.** All six-word sentences is as much a tell as all
  thirty-word ones.
- **Imperative for instructions, second person for context.** "Run `hunk
  diff`." "You do not manage sockets."
- **Every claim is concrete.** Name the command, key, flag, file, default,
  and limit. "Startup waits 30 seconds by default" beats "startup waits
  briefly". If the specific value is unknown, look it up in source — never
  document from memory, and never invent a flag, key, or behavior. Wrong docs
  are worse than missing docs.
- **Explain a flag right after the code block that introduces it.** One
  sentence, immediately — "`--exclude-untracked` limits the review to
  tracked changes" — so the reader never pastes something they don't
  understand.
- **State defaults, boundaries, and the why behind trade-offs.** "Untracked
  files are included by default." "It does not replay stdin patches."
  Readers trust docs that admit what a feature does not do.
- **Decide for the reader.** Comparison prose ends in "Use X when Y"
  sentences, not "both options have advantages".
- **Tables hold enumerable facts** — keys, states, statuses. Reasoning and
  sequence stay in prose. Never put a paragraph in a table cell.
- **Code spans for every literal**: commands, flags, keys, paths, config
  keys, values. `--watch`, `[vcs]`, `~/.config/hunk/config.toml`.
- **Links carry their reason.** In lists: "[Quick start](…) — open a review
  and learn the navigation model." Inline: link the noun, not "click here".

## Banned patterns (AI slop)

These patterns make docs read machine-generated and cost reader trust. Each
either praises the product instead of informing, or pads the sentence without
adding a fact.

- **Marketing adjectives**: powerful, seamless, robust, comprehensive,
  effortless, blazing/lightning-fast, rich, delightful, best-in-class,
  supercharge, elevate, unlock. If a quality matters, show the fact that
  proves it ("reloads in under a second") or cut it.
- **Throat-clearing openers**: "In this guide, we'll…", "Let's dive in",
  "Welcome to…". Start with the first true statement.
- **Scene-setting vignettes**: "When the code is still moving — an agent
  mid-task, a rebase in progress — watch mode…". Dramatized situations before
  the point are the flowery failure in a newer costume. State the job plainly
  and let the reader supply their own situation.
- **Restating the heading as the first sentence.** Under "## Install with
  Homebrew", do not write "You can install Hunk with Homebrew." Write the
  command.
- **simply / just / easily.** If it is simple, the short instruction shows
  it; if it is not, these words blame the reader.
- **"allows you to / enables you to / lets you"** — verb directly. "Hunk
  allows you to reload the review" → "Hunk reloads the review" or "Reload
  the review with `r`."
- **Filler and hedging**: "It's worth noting that", "Note that" (almost
  always deletable), "Additionally", "In order to" (→ "To"), "may want to
  consider" (→ say what to do), "should work" (→ say what happens).
- **The rule-of-three reflex** ("fast, flexible, and friendly") unless the
  three items are real, distinct, and enumerable.
- **The "not X, but Y" construction** more than rarely — a strong tell when
  every paragraph pivots on it.
- **Em-dash dependence.** One per paragraph is fine; one per sentence is a
  tell. Vary the punctuation.
- **Exclamation marks and emoji.** Never in docs prose.
- **Summary/conclusion sections** that restate the page. End with exit links.
- **Bullet inflation**: bullets for parallel items only; a bulleted list
  whose items are full paragraphs is prose wearing a costume.

Concision is about density, not brevity. A 30-line page that answers the
question beats a 150-line page that "covers the topic" — but edge semantics
(defaults, fallbacks, limits, exact error behavior) are the substance readers
came for. Cut words, never facts.

## Example rewrites

There are two ways to fail this rewrite, so the first example shows three
stages: the slop, the over-correction, and the target.

**Example 1**

Slop — the vocabulary is the problem, not the structure:

> Hunk offers a powerful and flexible watch mode that allows you to
> seamlessly keep your review up to date. Simply pass the `--watch` flag and
> Hunk will automatically handle the rest!

Over-corrected — the jargon is gone, but so is the flow. No sentence frames
the feature, and the facts stand in a row like a changelog:

> ```bash
> hunk diff --watch
> ```
>
> Hunk reloads file- and Git-backed input while preserving the review. Watch
> mode is continuous; press `q` when finished.

House style — same facts, framed and connected:

> Watch mode keeps the review in sync with the working tree:
>
> ```bash
> hunk diff --watch
> ```
>
> As the files change, Hunk reloads the input and preserves your place in
> the stream. It runs until you press `q`.

**Example 2**

Slop:

> It's worth noting that there are several different ways to configure Hunk,
> each with its own advantages. You may want to consider which approach best
> fits your workflow.

House style:

> Hunk layers its settings so each scope has a job: the user config holds
> your personal defaults, `.hunk/config.toml` holds what the whole
> repository should share, and CLI flags override both for a single run.

## Before you finish

Copy this checklist and check off each item:

```
Docs finish checklist:
- [ ] Reread the page as raw Markdown (agents and .md URLs consume it that way)
- [ ] Verified every command, flag, key, and default against source or --help
- [ ] Sidebar updated in website/astro.config.mjs and redirect added, if the page moved
- [ ] `bun run website:check` passes
- [ ] `bun run website:build` passes
- [ ] `bun run website:links` passes
- [ ] Changeset handled (empty changeset for docs-only PRs; feature docs ride the feature's changeset)
- [ ] One final pass over the diff hunting only for banned patterns
```

Do the banned-pattern pass last and on the diff alone — slop creeps back in
under editing pressure, and a scan with no other goal catches what a general
reread misses.
