import type { ReactNode } from "react";

/** Render commit authors and relative times with shared history color roles. */
export function CommitMetadataText({
  author,
  authorColor,
  relativeTime,
  relativeTimeColor,
  separatorColor,
}: {
  author?: string;
  authorColor: string;
  relativeTime?: string;
  relativeTimeColor: string;
  separatorColor: string;
}): ReactNode {
  return (
    <text>
      {author ? <span fg={authorColor}>{author}</span> : null}
      {author && relativeTime ? <span fg={separatorColor}> · </span> : null}
      {relativeTime ? <span fg={relativeTimeColor}>{relativeTime}</span> : null}
    </text>
  );
}
