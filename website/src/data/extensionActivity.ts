/** GitHub topic an author adds to be listed. */
export const HUNK_EXTENSION_TOPIC = "hunk-extension";

/** Repository facts fetched from GitHub, absent when GitHub omits them. */
export interface ExtensionActivity {
  stars?: number;
  pushedAt?: string;
  createdAt?: string;
}

/** One compact repository record returned by Hunk's cached activity endpoint. */
export interface PublishedExtensionActivity extends ExtensionActivity {
  repo: string;
}

/** Browser-safe response from Hunk's cached extension activity endpoint. */
export interface ExtensionActivityPayload {
  fetchedAt: string;
  repositories: PublishedExtensionActivity[];
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

/** Index one topic-search response by lowercased `owner/name`. */
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

/** Build the one GitHub topic-search URL used by builds and the cached endpoint. */
export function githubTopicActivityUrl() {
  const query = encodeURIComponent(`topic:${HUNK_EXTENSION_TOPIC} is:public`);
  return `https://api.github.com/search/repositories?q=${query}&per_page=100`;
}

/** Serialize indexed GitHub facts into the compact first-party response shape. */
export function createExtensionActivityPayload(
  activity: ReadonlyMap<string, ExtensionActivity>,
  fetchedAt = new Date(),
): ExtensionActivityPayload {
  return {
    fetchedAt: fetchedAt.toISOString(),
    repositories: [...activity].map(([repo, facts]) => ({ repo, ...facts })),
  };
}

/** Index one first-party activity response, ignoring malformed records. */
export function indexPublishedActivity(payload: unknown): Map<string, ExtensionActivity> {
  const repositories =
    typeof payload === "object" && payload !== null
      ? (payload as { repositories?: unknown }).repositories
      : undefined;
  if (!Array.isArray(repositories)) return new Map();

  const activity = new Map<string, ExtensionActivity>();
  for (const record of repositories) {
    if (typeof record !== "object" || record === null) continue;
    const value = record as Record<string, unknown>;
    if (typeof value.repo !== "string") continue;
    activity.set(value.repo.toLowerCase(), {
      stars: typeof value.stars === "number" ? value.stars : undefined,
      pushedAt: typeof value.pushedAt === "string" ? value.pushedAt : undefined,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined,
    });
  }
  return activity;
}
