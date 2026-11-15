/**
 * Keeps the review capability out of the address bar while the tab stays usable.
 *
 * The review link carries the capability as a fragment parameter (`#capability=…`), beside any
 * other fragment parameters such as a deep link. On first load the page reads it, keeps it in
 * `sessionStorage` under a key naming the session (so it lives only as long as the tab and never
 * reaches another tab, the server, or a log), and removes that one parameter from the address
 * with `history.replaceState`, leaving every other fragment parameter in place. A reload reads
 * it back from storage. A tab with neither cannot reach the review, and the page says how to get
 * a fresh link. "Copy review link" rebuilds the full link on purpose.
 *
 * A link pasted into a tab already on the session navigates within the document (`hashchange`,
 * or `popstate` for Back and Forward onto an entry that still carries the key), so
 * `watchReviewCapability` moves that key out of the address the same way.
 */
import {
  HUNK_REVIEW_CAPABILITY_FRAGMENT_KEY,
  isReviewCapabilityToken,
  parseReviewCapabilityFragment,
} from "../../session/reviewHttpProtocol";

/** The storage this module reads and writes; `sessionStorage` in the page. */
export type CapabilityStorage = Pick<Storage, "getItem" | "setItem">;

/** The `sessionStorage` key one session's capability is kept under. */
export function reviewCapabilityStorageKey(sessionId: string) {
  return `hunk.review.capability:${sessionId}`;
}

/** The fragment without its capability parameter: `""` when nothing else remains. */
export function fragmentWithoutCapability(hash: string) {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  params.delete(HUNK_REVIEW_CAPABILITY_FRAGMENT_KEY);
  const rest = params.toString();
  return rest ? `#${rest}` : "";
}

/**
 * Read this tab's capability for one session, moving it out of the address when it is there.
 *
 * Returns nothing when neither the address nor this tab's storage holds a usable one.
 */
export function takeReviewCapability(input: {
  sessionId: string;
  location: { pathname: string; search?: string; hash: string };
  storage?: CapabilityStorage;
  history?: Pick<History, "replaceState">;
}): string | undefined {
  const key = reviewCapabilityStorageKey(input.sessionId);
  const fromAddress = parseReviewCapabilityFragment(input.location.hash);
  if (fromAddress) {
    try {
      input.storage?.setItem(key, fromAddress);
    } catch {
      // Storage refused: the capability still works for this load, just not after a reload.
    }
    input.history?.replaceState(
      null,
      "",
      `${input.location.pathname}${input.location.search ?? ""}${fragmentWithoutCapability(input.location.hash)}`,
    );
    return fromAddress;
  }
  let stored: string | null = null;
  try {
    stored = input.storage?.getItem(key) ?? null;
  } catch {
    stored = null;
  }
  return isReviewCapabilityToken(stored) ? stored : undefined;
}

/** The window events and location `watchReviewCapability` listens to. */
export interface CapabilityWatchTarget {
  location: { pathname: string; search?: string; hash: string };
  addEventListener(type: "hashchange" | "popstate", listener: () => void): void;
  removeEventListener(type: "hashchange" | "popstate", listener: () => void): void;
}

/**
 * Move a capability that arrives in the address after load into tab storage and out of the
 * address, as `takeReviewCapability` does on first load. Returns the function that stops it.
 */
export function watchReviewCapability(input: {
  sessionId: string;
  target: CapabilityWatchTarget;
  storage?: CapabilityStorage;
  history?: Pick<History, "replaceState">;
}): () => void {
  const onChange = () => {
    if (!parseReviewCapabilityFragment(input.target.location.hash)) return;
    takeReviewCapability({
      sessionId: input.sessionId,
      location: input.target.location,
      ...(input.storage ? { storage: input.storage } : {}),
      ...(input.history ? { history: input.history } : {}),
    });
  };
  input.target.addEventListener("hashchange", onChange);
  input.target.addEventListener("popstate", onChange);
  return () => {
    input.target.removeEventListener("hashchange", onChange);
    input.target.removeEventListener("popstate", onChange);
  };
}

/** Rebuild the full review link for this tab: the address with the capability put back. */
export function reviewLinkWithCapability(
  location: { origin: string; pathname: string; hash: string },
  capability: string,
) {
  const params = new URLSearchParams(
    location.hash.startsWith("#") ? location.hash.slice(1) : location.hash,
  );
  params.delete(HUNK_REVIEW_CAPABILITY_FRAGMENT_KEY);
  const rest = params.toString();
  const capabilityParam = new URLSearchParams({
    [HUNK_REVIEW_CAPABILITY_FRAGMENT_KEY]: capability,
  }).toString();
  return `${location.origin}${location.pathname}#${capabilityParam}${rest ? `&${rest}` : ""}`;
}
