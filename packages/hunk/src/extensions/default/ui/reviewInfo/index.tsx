import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import { useEffect, useState, type ReactNode } from "react";
import type { ExtensionFactory } from "../../../types";
import type {
  ExtensionPaneProps,
  ExtensionReviewDescriptor,
} from "../../../../extension-api/types";
import { diffRailMarker } from "../../../../ui/diff/rowStyle";
import { reviewInfoContent } from "./presentation";

export const BUNDLED_REVIEW_INFO_VIEW_ID = "review-info";

/** Report whether the bundled pane has a concise projection for this review kind. */
function supportsReviewInfo(
  review: ExtensionReviewDescriptor | null,
): review is Extract<ExtensionReviewDescriptor, { kind: "change-request" | "commit" }> {
  return review?.kind === "change-request" || review?.kind === "commit";
}

/** Render change-request or commit identity above the review without duplicating diff facts. */
export function ReviewInfoPane({ actions, review, theme, width }: ExtensionPaneProps): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  const commitAuthoredAt = review?.kind === "commit" ? review.authoredAt : undefined;
  useEffect(() => {
    if (!commitAuthoredAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [commitAuthoredAt]);

  if (!supportsReviewInfo(review)) return null;
  const { primary, secondary, trailing } = reviewInfoContent(review, Math.max(0, width - 3), now);
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
                <box
                  style={{ flexDirection: "row", gap: 1 }}
                  onMouseUp={(event: TuiMouseEvent) => {
                    event.stopPropagation();
                    actions.copyText(review.revision);
                  }}
                >
                  <text fg={theme.fileRenamed}>{trailing}</text>
                  <text fg={theme.copyAction}>⧉</text>
                </box>
              ) : null}
            </box>
            <text fg={theme.muted}>{secondary}</text>
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
    available: ({ review }) => supportsReviewInfo(review),
    component: ReviewInfoPane,
  });
};

export default registerBundledReviewInfo;
