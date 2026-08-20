/**
 * Curated seed for the hunk.dev extension directory.
 *
 * Every entry is a public repository tagged `hunk-extension` on GitHub. The
 * list is hand-maintained while the directory is a preview; the shape below is
 * what an indexer reading the topic would produce, so replacing the literal
 * with generated data is the only change that step needs. Static facts
 * (summary, categories, manifest values) live here so the page renders without
 * a network call; volatile facts (stars, dates) are fetched at build time and
 * simply omitted when the fetch fails.
 */

/** GitHub topic an author adds to be listed. */
export const HUNK_EXTENSION_TOPIC = "hunk-extension";

/**
 * What an extension registers, in the words the docs use for those surfaces.
 *
 * Derived by hand from each extension's entry file today, and declarable by
 * authors later; either way the category names have to stay the ones the
 * authoring guide uses, because they are how a reader maps a listing onto a
 * docs page — and, once the directory is long, the filter they browse by.
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
  /** One curated line. Repository descriptions drift and get noisy. */
  summary: string;
  /** Surfaces it registers. */
  categories: readonly ExtensionCategory[];
  /** Manifest `version`, so a card can say what installing gets you. */
  version: string;
  /** `hunk.apiVersion` from its manifest: the Hunk surface it needs. */
  apiVersion: number;
}

/** Repository facts fetched at build time, absent when GitHub is unreachable. */
export interface ExtensionActivity {
  stars?: number;
  pushedAt?: string;
  createdAt?: string;
}

/** One listing as the page renders it. */
export type ExtensionEntry = ExtensionListing & ExtensionActivity;

/**
 * The listed extensions.
 *
 * Order here is only the fallback the page sorts away from, so it stays
 * alphabetical by repository with Hunk's own extension first; readers reorder
 * it with the sort control.
 */
export const EXTENSION_CATALOG: readonly ExtensionListing[] = [
  {
    repo: "modem-dev/hunk-hg",
    name: "hunk-hg",
    summary:
      "Adds Mercurial support, so Hunk reviews an hg working copy the way it reviews a Git one.",
    categories: ["VCS backend"],
    version: "0.1.0",
    apiVersion: 4,
  },
  {
    repo: "modem-dev/hunk-lens",
    name: "hunk-lens",
    summary: "Keeps the current split-diff line in view, and paints its context beside the review.",
    categories: ["Pane", "Command"],
    version: "0.1.0",
    apiVersion: 4,
  },
  {
    repo: "astwys/hunk-adaptive-theme",
    name: "hunk-adaptive-theme",
    summary: "Picks a Hunk theme to match your terminal background at startup.",
    categories: ["Theme"],
    version: "0.1.0",
    apiVersion: 6,
  },
  {
    repo: "astwys/hunk-diff-context",
    name: "hunk-diff-context",
    summary:
      "Pins the selected file's complete diff in a sidebar pane, so it stays visible beside the review.",
    categories: ["Pane", "Command"],
    version: "0.1.0",
    apiVersion: 6,
  },
  {
    repo: "astwys/hunk-exclude-files",
    name: "hunk-exclude-files",
    summary: "Hides files matching configured glob rules from the review stream.",
    categories: ["Changeset transform"],
    version: "0.1.0",
    apiVersion: 6,
  },
  {
    repo: "elucid/hunk-less-search",
    name: "hunk-less-search",
    summary: "less-style forward search across the review stream, with in-diff match marks.",
    categories: ["Keyboard mode", "Line highlighter", "Pane", "Command"],
    version: "0.1.0",
    apiVersion: 5,
  },
  {
    repo: "gentilfp/hunk-codeowners",
    name: "hunk-codeowners",
    summary:
      "Shows CODEOWNERS context for the changeset and selected file, without leaving the terminal.",
    categories: ["Pane", "Command"],
    version: "0.1.0",
    apiVersion: 6,
  },
  {
    repo: "mikeclarke/hunk-tutor",
    name: "hunk-tutor",
    summary: "An interactive tour of Hunk, taught inside a practice review.",
    categories: ["Pane", "Theme", "Line highlighter", "Command", "VCS backend"],
    version: "0.1.0",
    apiVersion: 5,
  },
  {
    repo: "phl28/hunk-gh-review",
    name: "hunk-gh-review",
    summary:
      "Turns Hunk into a GitHub review client: browse and reply to PR threads, then submit notes as a review.",
    categories: ["Pane", "Keyboard mode", "Command"],
    version: "0.1.0",
    apiVersion: 6,
  },
];

/**
 * Serialize one value for a raw `<script type="application/ld+json">` body.
 *
 * `JSON.stringify` leaves `<` alone, so a listing whose text contained
 * `</script>` would close the element and turn the rest of the payload into
 * markup. Escaping `<` as its JSON unicode escape keeps the document valid
 * JSON-LD while making that impossible. The catalog is hand-reviewed today and
 * will be generated from repository descriptions nobody reviews.
 */
export function toJsonLdScriptBody(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** GitHub account that publishes one listing. */
export function ownerOf(listing: ExtensionListing) {
  return listing.repo.split("/")[0] ?? listing.repo;
}

/** Repository page for one listing. */
export function repositoryUrl(listing: ExtensionListing) {
  return `https://github.com/${listing.repo}`;
}

/** Owner avatar, sized for a card and served by GitHub itself. */
export function avatarUrl(listing: ExtensionListing, size: number) {
  return `https://github.com/${encodeURIComponent(ownerOf(listing))}.png?size=${size}`;
}

/** The command a reader copies to install one listing. */
export function installCommand(listing: ExtensionListing) {
  return `hunk extension install ${listing.repo}`;
}

/**
 * Categories present in one set of entries, with how many carry each.
 *
 * The filter offers only categories something is actually tagged with, so the
 * directory never shows a chip that leads to an empty grid.
 */
export function categoryFacets(entries: readonly ExtensionListing[]) {
  const counts = new Map<ExtensionCategory, number>();
  for (const entry of entries) {
    for (const category of entry.categories) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }

  return [...counts]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
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

/** Headers GitHub wants, with the build's token when it has one. */
function githubHeaders() {
  const token = process.env.GITHUB_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Read one repository's volatile facts out of a GitHub API repository object. */
export function readActivity(value: unknown): ExtensionActivity {
  if (typeof value !== "object" || value === null) return {};
  const repository = value as Record<string, unknown>;
  return {
    stars:
      typeof repository.stargazers_count === "number" ? repository.stargazers_count : undefined,
    pushedAt: typeof repository.pushed_at === "string" ? repository.pushed_at : undefined,
    createdAt: typeof repository.created_at === "string" ? repository.created_at : undefined,
  };
}

/**
 * Index one topic-search response by lowercased `owner/name`.
 *
 * The search is the same query the future indexer runs, so one request covers
 * every tagged repository however long the catalog gets — where a request per
 * listing would exhaust an unauthenticated build's hourly budget well before a
 * hundred listings and lose every star count at once.
 */
export function indexActivityByRepo(payload: unknown): Map<string, ExtensionActivity> {
  const items =
    typeof payload === "object" && payload !== null
      ? (payload as { items?: unknown }).items
      : undefined;
  if (!Array.isArray(items)) return new Map();

  const byRepo = new Map<string, ExtensionActivity>();
  for (const item of items) {
    const fullName =
      typeof item === "object" && item !== null
        ? (item as { full_name?: unknown }).full_name
        : undefined;
    if (typeof fullName !== "string") continue;
    byRepo.set(fullName.toLowerCase(), readActivity(item));
  }

  return byRepo;
}

/** Search the topic for every tagged repository's current metadata. */
async function fetchTopicActivity(): Promise<Map<string, ExtensionActivity>> {
  const query = encodeURIComponent(`topic:${HUNK_EXTENSION_TOPIC} is:public`);
  try {
    const response = await fetch(
      `https://api.github.com/search/repositories?q=${query}&per_page=100`,
      { headers: githubHeaders(), signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) {
      console.warn(
        `Extension directory: GitHub topic search returned ${response.status}; rendering without stars.`,
      );
      return new Map();
    }

    return indexActivityByRepo(await response.json());
  } catch (error) {
    console.warn(
      `Extension directory: GitHub topic search failed (${error instanceof Error ? error.message : String(error)}); rendering without stars.`,
    );
    return new Map();
  }
}

/** Read one listing the topic search did not return, so it still gets metadata. */
async function fetchListingActivity(listing: ExtensionListing): Promise<ExtensionActivity> {
  try {
    const response = await fetch(`https://api.github.com/repos/${listing.repo}`, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok ? readActivity(await response.json()) : {};
  } catch {
    // A directory that renders without stars beats a build that fails on them.
    return {};
  }
}

/**
 * Resolve every listing with whatever repository activity the build can reach.
 *
 * One topic search covers everything tagged; anything the catalog lists that
 * the search did not return is read directly and named in the build log, since
 * a listing missing from its own topic is a catalog bug — it will vanish the
 * day this list is generated from the topic instead of maintained by hand.
 */
export async function loadExtensionEntries(): Promise<ExtensionEntry[]> {
  const tagged = await fetchTopicActivity();
  const untagged = EXTENSION_CATALOG.filter((listing) => !tagged.has(listing.repo.toLowerCase()));
  if (tagged.size > 0 && untagged.length > 0) {
    console.warn(
      `Extension directory: ${untagged.map((listing) => listing.repo).join(", ")} ` +
        `${untagged.length === 1 ? "is" : "are"} listed but not tagged \`${HUNK_EXTENSION_TOPIC}\`.`,
    );
  }

  const direct = new Map(
    await Promise.all(
      untagged.map(async (listing) => [listing.repo, await fetchListingActivity(listing)] as const),
    ),
  );

  return EXTENSION_CATALOG.map((listing) => ({
    ...listing,
    ...(tagged.get(listing.repo.toLowerCase()) ?? direct.get(listing.repo)),
  }));
}
