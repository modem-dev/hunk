import { useEffect, useState, type ReactNode } from "react";
import type { ExtensionFactory } from "../../../types";
import type {
  ExtensionPaneProps,
  ExtensionReviewDescriptor,
} from "../../../../extension-api/types";
import { CommitMetadataText } from "../../../../ui/components/CommitMetadataText";
import { RevisionIdControl } from "../../../../ui/components/RevisionIdControl";
import { diffRailMarker } from "../../../../ui/diff/rowStyle";
import { comparisonCommitContent, reviewInfoContent } from "./presentation";

export const BUNDLED_REVIEW_INFO_VIEW_ID = "review-info";
export const BUNDLED_COMPARISON_REVIEW_INFO_VIEW_ID = "comparison-review-info";

/** Report whether the bundled pane has a concise projection for this review kind. */
function supportsReviewInfo(
  review: ExtensionReviewDescriptor | null,
): review is Extract<
  ExtensionReviewDescriptor,
  { kind: "change-request" | "commit" | "comparison" }
> {
  return (
    review?.kind === "change-request" || review?.kind === "commit" || review?.kind === "comparison"
  );
}

/** Keep fixed summaries separate from the responsive multi-commit pane. */
function supportsFixedReviewInfo(review: ExtensionReviewDescriptor | null) {
  return supportsReviewInfo(review) && !(review.kind === "comparison" && review.commits?.length);
}

/** Report whether a comparison carries commit rows for responsive enumeration. */
function supportsComparisonReviewInfo(review: ExtensionReviewDescriptor | null): review is Extract<
  ExtensionReviewDescriptor,
  { kind: "comparison" }
> & {
  commits: NonNullable<Extract<ExtensionReviewDescriptor, { kind: "comparison" }>["commits"]>;
} {
  return review?.kind === "comparison" && Boolean(review.commits?.length);
}

/** Render review identity above the diff without duplicating file-level facts. */
export function ReviewInfoPane({
  actions,
  height,
  review,
  theme,
  width,
}: ExtensionPaneProps): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  const updatesRelativeTime =
    (review?.kind === "commit" && Boolean(review.authoredAt)) ||
    (review?.kind === "comparison" && Boolean(review.commits?.some((commit) => commit.authoredAt)));
  useEffect(() => {
    if (!updatesRelativeTime) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [updatesRelativeTime]);

  if (!supportsReviewInfo(review)) return null;
  const contentWidth = Math.max(0, width - 3);
  const comparisonCommits = review.kind === "comparison" ? review.commits : undefined;
  if (comparisonCommits?.length) {
    const availableRows = Math.max(0, height - 1);
    const totalCommits =
      (review.kind === "comparison" ? review.commitCount : undefined) ?? comparisonCommits.length;
    const needsOverflow = totalCommits > availableRows;
    const visibleCount = Math.max(
      0,
      Math.min(comparisonCommits.length, availableRows - (needsOverflow ? 1 : 0)),
    );
    const omittedCount = Math.max(0, totalCommits - visibleCount);
    return (
      <box
        style={{
          width: "100%",
          height: "100%",
          flexDirection: "column",
          backgroundColor: theme.panel,
        }}
      >
        <text fg={theme.border} bg={theme.panel}>
          {"─".repeat(Math.max(0, width))}
        </text>
        {comparisonCommits.slice(0, visibleCount).map((commit, index) => {
          const row = comparisonCommitContent(commit, contentWidth, now);
          return (
            <box
              key={`${commit.revision}:${index}`}
              style={{ width: "100%", height: 1, flexDirection: "row" }}
            >
              <text fg={theme.accent} bg={theme.panel}>
                {diffRailMarker()}
              </text>
              <box style={{ width: Math.max(0, width - 1), flexDirection: "row", paddingLeft: 1 }}>
                <box style={{ width: row.titleWidth }}>
                  <text fg={theme.text}>{row.title}</text>
                </box>
                {row.metadataWidth ? (
                  <box style={{ width: row.metadataWidth + 1, paddingLeft: 1 }}>
                    <CommitMetadataText
                      author={row.metadataAuthor}
                      relativeTime={row.metadataRelativeTime}
                      authorColor={theme.historyAuthor ?? theme.badgeAdded}
                      separatorColor={theme.historySeparator ?? theme.muted}
                      relativeTimeColor={theme.historyRelativeTime ?? theme.muted}
                    />
                  </box>
                ) : null}
                {row.revisionWidth ? (
                  <box style={{ width: row.revisionWidth + 1, paddingLeft: 1 }}>
                    <RevisionIdControl
                      displayRevision={row.displayRevision}
                      revisionColor={theme.fileRenamed}
                      copyColor={theme.copyAction}
                      onCopy={() => actions.copyText(commit.revision)}
                    />
                  </box>
                ) : null}
              </box>
            </box>
          );
        })}
        {omittedCount ? (
          <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
            <text fg={theme.accent} bg={theme.panel}>
              {diffRailMarker()}
            </text>
            <text fg={theme.muted}> {`… ${omittedCount} more commits`}</text>
          </box>
        ) : null}
      </box>
    );
  }
  const { primary, secondary, secondaryCommitMetadata, trailing } = reviewInfoContent(
    review,
    contentWidth,
    now,
  );
  if (width <= 1) {
    return (
      <box style={{ width: 1, height: 3, flexDirection: "column", backgroundColor: theme.panel }}>
        <text fg={theme.border} bg={theme.panel}>
          ─
        </text>
        <text fg={theme.accent} bg={theme.panel}>
          {diffRailMarker()}
        </text>
        <text fg={theme.accent} bg={theme.panel}>
          {diffRailMarker()}
        </text>
      </box>
    );
  }
  return (
    <box
      style={{
        width: "100%",
        height: 3,
        flexDirection: "column",
        backgroundColor: theme.panel,
      }}
    >
      <text fg={theme.border} bg={theme.panel}>
        {"─".repeat(Math.max(0, width))}
      </text>
      <box style={{ width: "100%", height: 2, flexDirection: "row" }}>
        <box style={{ width: 1, height: 2, flexDirection: "column", backgroundColor: theme.panel }}>
          <text fg={theme.accent} bg={theme.panel}>
            {diffRailMarker()}
          </text>
          <text fg={theme.accent} bg={theme.panel}>
            {diffRailMarker()}
          </text>
        </box>
        {width > 1 ? (
          <box
            style={{
              width: width - 1,
              height: 2,
              paddingLeft: width >= 2 ? 1 : 0,
              paddingRight: width >= 3 ? 1 : 0,
              flexDirection: "column",
              backgroundColor: theme.panel,
            }}
          >
            <box
              style={{
                width: "100%",
                height: 1,
                flexDirection: "row",
                justifyContent: "space-between",
              }}
            >
              <text fg={theme.text}>{primary}</text>
              {trailing && review.kind === "commit" ? (
                <RevisionIdControl
                  displayRevision={trailing}
                  revisionColor={theme.fileRenamed}
                  copyColor={theme.copyAction}
                  onCopy={() => actions.copyText(review.revision)}
                />
              ) : null}
            </box>
            {secondaryCommitMetadata ? (
              <CommitMetadataText
                author={secondaryCommitMetadata.author}
                relativeTime={secondaryCommitMetadata.relativeTime}
                authorColor={theme.historyAuthor ?? theme.badgeAdded}
                separatorColor={theme.historySeparator ?? theme.muted}
                relativeTimeColor={theme.historyRelativeTime ?? theme.muted}
              />
            ) : (
              <text fg={theme.muted}>{secondary}</text>
            )}
          </box>
        ) : null}
      </box>
    </box>
  );
}

/** Register the provider-neutral review summary pane. */
const registerBundledReviewInfo: ExtensionFactory = (hunk) => {
  hunk.registerPane({
    id: BUNDLED_REVIEW_INFO_VIEW_ID,
    title: "Review info",
    placement: "top",
    height: { preferred: 3, min: 3, max: 3 },
    defaultOpen: true,
    available: ({ review }) => supportsFixedReviewInfo(review),
    component: ReviewInfoPane,
  });
};

/** Register the responsive multi-commit review summary pane. */
export const registerBundledComparisonReviewInfo: ExtensionFactory = (hunk) => {
  hunk.registerPane({
    id: BUNDLED_COMPARISON_REVIEW_INFO_VIEW_ID,
    title: "Review info",
    placement: "top",
    height: { preferred: 3, min: 3, max: 10 },
    defaultOpen: true,
    resizable: false,
    available: ({ review }) => supportsComparisonReviewInfo(review),
    preferredSize: ({ review }) => {
      if (!supportsComparisonReviewInfo(review)) return 3;
      const commits = review.commits?.length ?? 0;
      const total = review.commitCount ?? commits;
      return 1 + commits + (total > commits ? 1 : 0);
    },
    component: ReviewInfoPane,
  });
};

export default registerBundledReviewInfo;
