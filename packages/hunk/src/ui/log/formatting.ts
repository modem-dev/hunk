import type { ExtensionVcsHistoryCommit } from "../../extension-api/types";

const DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** Return a local-calendar key used to keep adjacent commits in the same day group. */
export function historyDayKey(authoredAt: string) {
  const date = new Date(authoredAt);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Format one GitHub-style local-calendar heading for a commit day. */
export function formatHistoryDay(authoredAt: string) {
  return `Commits on ${DAY_FORMATTER.format(new Date(authoredAt))}`;
}

/** Resolve an offline account-like handle from provider-supplied commit identity. */
export function resolveHistoryAuthorLabel(commit: ExtensionVcsHistoryCommit) {
  const email = commit.authorEmail?.trim();
  if (email) {
    const github = email.match(/^(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com$/i);
    if (github?.[1]) return github[1];
    const separator = email.indexOf("@");
    if (separator > 0) return email.slice(0, separator);
  }
  return commit.authorName;
}

/** Format elapsed commit time with stable GitHub-style relative units. */
export function formatHistoryRelativeTime(authoredAt: string, now = Date.now()) {
  const deltaSeconds = Math.trunc((now - Date.parse(authoredAt)) / 1000);
  const future = deltaSeconds < 0;
  const seconds = Math.abs(deltaSeconds);
  const [value, unit] =
    seconds < 60
      ? ([0, "moment"] as const)
      : seconds < 3_600
        ? ([Math.floor(seconds / 60), "minute"] as const)
        : seconds < 86_400
          ? ([Math.floor(seconds / 3_600), "hour"] as const)
          : seconds < 2_592_000
            ? ([Math.floor(seconds / 86_400), "day"] as const)
            : seconds < 31_536_000
              ? ([Math.floor(seconds / 2_592_000), "month"] as const)
              : ([Math.floor(seconds / 31_536_000), "year"] as const);
  if (unit === "moment") return future ? "in a moment" : "just now";
  const label = `${value} ${unit}${value === 1 ? "" : "s"}`;
  return future ? `in ${label}` : `${label} ago`;
}
