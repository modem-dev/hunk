/**
 * Curated seed for the hunk.dev extension directory.
 *
 * Every entry is a public repository tagged `hunk-extension` on GitHub. The
 * list is hand-maintained while the directory is a preview; the shape below is
 * what an indexer reading the topic would produce, so replacing the literal
 * with generated data is the only change that step needs. Static facts
 * (summary, categories, manifest values) live here so the page renders without
 * a network call; volatile facts (stars, last push) are fetched at build time
 * and simply omitted when the fetch fails.
 */

/** GitHub topic an author adds to be listed. */
export const HUNK_EXTENSION_TOPIC = "hunk-extension";

/** Browse URL for the topic itself, for authors and for the unlisted tail. */
export const HUNK_EXTENSION_TOPIC_URL = `https://github.com/topics/${HUNK_EXTENSION_TOPIC}`;

/**
 * Extension API version this site documents as current.
 *
 * Mirrors `HUNK_EXTENSION_API_VERSION` in `src/extension-api/types.ts`;
 * `scripts/check-extension-catalog.test.ts` fails the build when they drift.
 */
export const CURRENT_EXTENSION_API_VERSION = 7;

/**
 * What an extension registers, in the words the docs use for those surfaces.
 *
 * Derived by hand from each extension's entry file today, and declarable by
 * authors later; either way the category names have to stay the ones the
 * authoring guide uses, because they are how a reader maps a listing onto a
 * docs page.
 */
export type ExtensionCategory =
  | "Pane"
  | "Theme"
  | "Command"
  | "Keyboard mode"
  | "Line highlighter"
  | "File view"
  | "VCS backend"
  | "Changeset transform";

/** One directory listing, before build-time repository metadata is merged in. */
export interface ExtensionListing {
  /** `owner/name`, the argument `hunk extension install` takes. */
  repo: string;
  /** Manifest `name`; the id the extension owns once installed. */
  name: string;
  /** Who publishes it, for the byline. */
  author: string;
  /** One curated line. Repository descriptions drift and get noisy. */
  summary: string;
  /** Surfaces it registers. */
  categories: readonly ExtensionCategory[];
  /** `hunk.apiVersion` from its manifest: the Hunk surface it needs. */
  apiVersion: number;
  /** SPDX id from its manifest. */
  license: string;
}

/** Repository facts fetched at build time, absent when GitHub is unreachable. */
export interface ExtensionActivity {
  stars?: number;
  pushedAt?: string;
}

/** One listing as the page renders it. */
export type ExtensionEntry = ExtensionListing & ExtensionActivity;

/**
 * The listed extensions, in the order the page shows them.
 *
 * Hunk's own extension leads; the rest follow alphabetically by repository, so
 * the order is stable and nothing looks ranked while the list is this short.
 */
export const EXTENSION_CATALOG: readonly ExtensionListing[] = [
  {
    repo: "modem-dev/hunk-lens",
    name: "hunk-lens",
    author: "Modem",
    summary: "Keeps the current split-diff line in view, and paints its context beside the review.",
    categories: ["Pane", "Command"],
    apiVersion: 4,
    license: "MIT",
  },
  {
    repo: "astwys/hunk-adaptive-theme",
    name: "hunk-adaptive-theme",
    author: "astwys",
    summary: "Picks a Hunk theme to match your terminal background at startup.",
    categories: ["Theme"],
    apiVersion: 6,
    license: "MIT",
  },
  {
    repo: "astwys/hunk-exclude-files",
    name: "hunk-exclude-files",
    author: "astwys",
    summary: "Hides files matching configured glob rules from the review stream.",
    categories: ["Changeset transform"],
    apiVersion: 6,
    license: "MIT",
  },
  {
    repo: "elucid/hunk-less-search",
    name: "hunk-less-search",
    author: "elucid",
    summary: "less-style forward search across the review stream, with in-diff match marks.",
    categories: ["Keyboard mode", "Line highlighter", "Pane", "Command"],
    apiVersion: 5,
    license: "MIT",
  },
  {
    repo: "mikeclarke/hunk-tutor",
    name: "hunk-tutor",
    author: "mikeclarke",
    summary: "An interactive tour of Hunk, taught inside a practice review.",
    categories: ["Pane", "Theme", "Line highlighter", "Command", "VCS backend"],
    apiVersion: 5,
    license: "MIT",
  },
];

/** Repository page for one listing. */
export function repositoryUrl(listing: ExtensionListing) {
  return `https://github.com/${listing.repo}`;
}

/** The command a reader copies to install one listing. */
export function installCommand(listing: ExtensionListing) {
  return `hunk extension install ${listing.repo}`;
}

/** Phrase one ISO timestamp as the coarse recency a directory card wants. */
export function formatUpdated(pushedAt: string, now = new Date()) {
  const days = Math.floor((now.getTime() - new Date(pushedAt).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return undefined;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** Read one repository's volatile facts, or nothing when GitHub says no. */
async function fetchActivity(listing: ExtensionListing): Promise<ExtensionActivity> {
  try {
    const token = process.env.GITHUB_TOKEN;
    const response = await fetch(`https://api.github.com/repos/${listing.repo}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return {};
    const data = (await response.json()) as { stargazers_count?: unknown; pushed_at?: unknown };
    return {
      stars: typeof data.stargazers_count === "number" ? data.stargazers_count : undefined,
      pushedAt: typeof data.pushed_at === "string" ? data.pushed_at : undefined,
    };
  } catch {
    // A directory that renders without stars beats a build that fails on them.
    return {};
  }
}

/** Resolve every listing with whatever repository activity the build can reach. */
export async function loadExtensionEntries(): Promise<ExtensionEntry[]> {
  const activity = await Promise.all(EXTENSION_CATALOG.map(fetchActivity));
  return EXTENSION_CATALOG.map((listing, index) => ({ ...listing, ...activity[index] }));
}
