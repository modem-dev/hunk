---
name: write-docs
description: House style and structure rules for writing Hunk documentation. Use whenever creating, editing, restructuring, or reviewing any Hunk docs — pages under website/src/content/docs/, the README, repo docs/*.md, changelog entries, or docs-heavy PR text. Also use when asked to "document" a feature, write a guide, improve docs wording, or check docs for AI-sounding prose, even if the word "docs" is not used.
---

# Writing Hunk docs

Rules for producing documentation that reads like it was written by a careful
human who knows the product. Distilled from what works in Hunk's existing docs
and the docs of herdr.dev and pi.dev — three terminal tools whose docs respect
the reader.

The one-sentence version: **say true, specific things in short declarative
sentences, structure pages around the reader's situation, and delete every word
that exists to impress rather than inform.**

## Where docs live

| Location | Audience | Notes |
| --- | --- | --- |
| `website/src/content/docs/docs/` | Users | The hunk.dev docs site (Starlight). Sidebar order lives in `website/astro.config.mjs`. |
| `website/src/content/docs/docs/reference/cli.md`, `config.md` | Users | **Generated** by `bun run generate:docs`. Never hand-edit; change the runtime metadata sources. |
| `skills/hunk-review/SKILL.md` | Agents | **Generated** by `bun run generate:skill`. Never hand-edit. |
| `docs/*.md` (repo root) | Contributors | Internal architecture and process notes. Do not link them from the user docs nav. |
| `README.md` | Both | Landing page for the repo; keep it a condensed pitch plus pointers, not a second manual. |

Every docs-site page is also served as raw Markdown (`<url>.md`) and bundled
into `/llms.txt` corpora for agents. Write pages so they read cleanly as plain
Markdown: no reliance on custom components for meaning, tables that make sense
unrendered, code blocks with language tags.

## Structure: pages

**One page, one job — stated immediately.** Open with a sentence that says what
the page covers and, when a sibling page could overlap, where the other topic
lives. pi's usage page opens: "This page collects day-to-day usage details that
do not fit on the quickstart page." That sentence prevents both duplication and
reader doubt. If you cannot write that sentence, the page's scope is wrong.

**Frontmatter description is a real summary.** It appears in link cards,
search, and the llms.txt index. Write what the page lets the reader do
("Diagnose missing input, session access, terminal behavior, and configuration
problems"), not a restated title.

**Order sections by reader commitment, not feature taxonomy.** The first screen
serves someone five minutes in; completeness lives further down or in the
reference. A keyboard page teaches the five keys that carry a review before the
full table. A config page shows the two-line config most people want before the
exhaustive options.

**When behavior varies by scenario, lead with a matrix.** Herdr's best page
opens with a "What survives" table — scenarios as rows, guarantees as columns —
then one section elaborates each row. Use that shape for anything like "which
input modes support watch", "what each terminal supports", "which config
section applies". The table answers the question; the sections explain it.
Nothing gets explained twice.

**End with an exit.** Guide pages close with two to four annotated next links
("[Agents](…) — supported agents, detection, and integrations"). Pages that
compare paths close with a short "Which to use" decision: one sentence per
path, naming the situation that picks it.

**Troubleshooting entries are symptom-titled pointers.** H2 is what the user
sees ("Enter fires twice", "Watch mode is rejected"), body is cause → exact fix
→ link to the section that owns the full explanation. Troubleshooting owns the
symptom-to-answer mapping, never the deep explanation — that lives on the
feature's page, where it stays current.

## Structure: the docs as a whole

- Groups follow the adoption journey: start → use → configure → extend →
  reference → help. A new page joins the group whose reader needs it, not the
  group that matches its implementation.
- Each sidebar group should open with a page that orients ("here are the paths,
  here is which to pick") before pages that go deep on one path.
- Define each product noun (review stream, hunk, session, note, changeset) on
  one page and link to it. If you are re-explaining a term inline, replace the
  explanation with a link.
- Guides and generated references have a contract: guides carry recipes,
  reasoning, and anything that needs more room than a reference row; the
  reference carries every key, flag, and default. Guides delegate ("see the
  [config reference](/docs/reference/config/)") instead of copying values —
  a hand-copied default goes stale silently.
- Moving or renaming a page changes its URL. Add a redirect and keep old links
  working; prefer names and groups you can live with.
- Keep audiences pure: deployment runbooks, benchmark notes, and architecture
  explorations belong in repo `docs/`, not in the user-facing nav.

## Language

Hunk's existing docs are the register to match: technical, economical, and a
little dry. When in doubt, read two existing pages first and match them.

- **Short declarative sentences, present tense, active voice.** The subject is
  Hunk, the command, or you. "Hunk reloads file-backed input." "Press `]` to
  jump to the next hunk." A sentence with two commas and an "and" usually
  wants to be two sentences.
- **Imperative for instructions, second person for context.** "Run `hunk
  diff`." "You do not manage sockets."
- **Every claim is concrete.** Name the command, key, flag, file, default, and
  limit. "Startup waits 30 seconds by default" beats "startup waits briefly".
  If you cannot name the specific value, look it up in source — never document
  from memory, and never invent a flag, key, or behavior. Wrong docs are worse
  than missing docs.
- **Explain a flag right after the code block that introduces it.** pi:
  "`--ignore-scripts` disables dependency lifecycle scripts during install."
  One sentence, immediately, so the reader never pastes something they don't
  understand.
- **State defaults, boundaries, and the why behind trade-offs.** "Pane history
  is off by default because pane output can include secrets." "It does not
  track individual turns." Readers trust docs that admit what a feature does
  not do.
- **Decide for the reader.** Comparison prose ends in "Use X when Y" sentences,
  not "both options have advantages".
- **Tables hold enumerable facts** — keys, states, assets, statuses. Reasoning
  and sequence stay in prose. Never put a paragraph in a table cell, and never
  bullet-point what is actually an argument.
- **Code spans for every literal**: commands, flags, keys, paths, config keys,
  values. `--watch`, `[vcs]`, `~/.config/hunk/config.toml`.
- **Links carry their reason.** In lists: "[Quickstart](…) — install,
  authenticate, and run a first session." Inline: link the noun, not "click
  here".

## Banned patterns (AI slop)

These patterns make docs read machine-generated and cost reader trust. Each is
banned because of what it does, not because of a style preference — most of
them either praise the product instead of informing, or pad the sentence
without adding a fact.

- **Marketing adjectives**: powerful, seamless, seamlessly, robust,
  comprehensive, effortless, blazing/lightning-fast, rich, delightful,
  best-in-class, supercharge, elevate, unlock. If a quality matters, show the
  fact that proves it ("reloads in under a second") or cut it.
- **Throat-clearing openers**: "In this guide, we'll…", "Let's dive in",
  "Welcome to…". Start with the first true statement instead.
- **Restating the heading as the first sentence.** Under "## Install with
  Homebrew", do not write "You can install Hunk with Homebrew." Write the
  command.
- **simply / just / easily.** If it is simple, the short instruction shows it;
  if it is not, these words blame the reader.
- **"allows you to / enables you to / lets you"** — verb directly. "Hunk
  allows you to reload the review" → "Hunk reloads the review" or "Reload the
  review with `r`."
- **Filler and hedging**: "It's worth noting that", "Note that" (almost always
  deletable), "Additionally", "In order to" (→ "To"), "may want to consider"
  (→ say what to do), "should work" (→ say what happens).
- **The rule-of-three reflex** ("fast, flexible, and friendly") unless the
  three items are real, distinct, and enumerable.
- **The "not X, but Y" construction** more than rarely — it is a strong tell
  when every paragraph pivots on it.
- **Em-dash dependence.** An em-dash per paragraph is fine; one per sentence is
  a tell. Vary the punctuation.
- **Exclamation marks and emoji.** Never in docs prose.
- **Summary/conclusion sections** that restate the page. End with the exit
  links instead.
- **Bullet inflation**: bullets for parallel items only; a bulleted list whose
  items are full paragraphs is prose wearing a costume.

Concision is about density, not brevity. A 30-line page that answers the
question beats a 150-line page that "covers the topic" — but edge semantics
(defaults, fallbacks, limits, exact error behavior) are the substance readers
came for. Cut words, never facts. Herdr-depth on behavior, Hunk-economy on
words.

## Example rewrites

**Slop:**

> Hunk offers a powerful and flexible watch mode that allows you to
> seamlessly keep your review up to date. Simply pass the `--watch` flag and
> Hunk will automatically handle the rest!

**House style:**

> ```bash
> hunk diff --watch
> ```
>
> Hunk reloads file- and Git-backed input while preserving the review. Watch
> mode is continuous; press `q` when finished. Stdin patches cannot be
> replayed, so `--watch` is rejected for pager input.

**Slop:**

> It's worth noting that there are several different ways to configure Hunk,
> each with its own advantages. You may want to consider which approach best
> fits your workflow.

**House style:**

> Repository settings override user settings; CLI flags win last. Use the user
> config for personal defaults and `.hunk/config.toml` for choices the whole
> repository should share.

## Before you finish

1. Reread the page as raw Markdown — agents and `.md` URLs consume it that way.
2. Verify every command, flag, key, and default against source or `--help`
   output, not memory.
3. If the page moved or the nav changed: update the sidebar in
   `website/astro.config.mjs` and add a redirect for the old slug.
4. Run the site checks from the repo root: `bun run website:check`,
   `bun run website:build`, `bun run website:links`.
5. Docs-only PRs take an empty changeset (`bun run changeset -- --empty`);
   docs that ship alongside a user-visible feature ride that feature's
   changeset.
6. Read the diff once more hunting only for the banned patterns above. They
   creep back in under editing pressure.
