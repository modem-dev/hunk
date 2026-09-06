import type { ReactNode } from "react";
import type { ExtensionFactory } from "../../../types";
import type { ExtensionPaneProps } from "../../../../extension-api/types";
import { reviewInfoLines } from "./presentation";

export const BUNDLED_REVIEW_INFO_VIEW_ID = "review-info";

/** Render delegated change-request identity above the review without duplicating diff facts. */
export function ReviewInfoPane({ review, theme, width }: ExtensionPaneProps): ReactNode {
  if (review?.kind !== "change-request") return null;
  const [primary, secondary] = reviewInfoLines(review, Math.max(0, width - 3));
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
        <box style={{ width: 1, height: 2, backgroundColor: theme.accent }} />
        <box
          style={{
            flexGrow: 1,
            height: 2,
            paddingLeft: 1,
            paddingRight: 1,
            flexDirection: "column",
            backgroundColor: theme.panel,
          }}
        >
          <text fg={theme.text}>{primary}</text>
          <text fg={theme.muted}>{secondary}</text>
        </box>
      </box>
    </box>
  );
}

/** Register the provider-neutral delegated change-request summary pane. */
const registerBundledReviewInfo: ExtensionFactory = (hunk) => {
  hunk.registerPane({
    id: BUNDLED_REVIEW_INFO_VIEW_ID,
    title: "Review info",
    placement: "top",
    height: { preferred: 3, min: 3, max: 3 },
    defaultOpen: true,
    available: ({ review }) => review?.kind === "change-request",
    component: ReviewInfoPane,
  });
};

export default registerBundledReviewInfo;
