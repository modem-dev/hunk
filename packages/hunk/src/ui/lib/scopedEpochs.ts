/**
 * Invalidation counters shared by pull-based extension surfaces.
 *
 * One prepared artifact (a file-view layout, a file's line highlights) is a
 * pure derivation of its inputs plus an invalidation epoch. Extensions bump an
 * epoch instead of pushing replacement state into the host, so a reload can
 * never leave stale host-held state behind.
 *
 * Two kinds of key live in one map: a scope-wide tuple counts invalidation for
 * every item of a scope (one registered view or highlighter), and an
 * item-scoped tuple narrows it to one reviewed file. Absent means zero: a
 * scope only earns an entry once something invalidates it, so the common
 * session never carries any epoch state at all.
 */
export type ScopedEpochState = ReadonlyMap<string, number>;

/** Encode a scope-wide or item-scoped epoch key without constraining extension-owned ids. */
function scopedEpochKey(scopeKey: string, itemId?: string) {
  // JSON string tuples stay unambiguous even when a registered id contains control characters.
  return JSON.stringify(itemId === undefined ? [scopeKey] : [scopeKey, itemId]);
}

/** Decode an internally generated epoch key, ignoring malformed external map entries. */
function parseScopedEpochKey(key: string): readonly [scopeKey: string, itemId?: string] | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (
      !Array.isArray(parsed) ||
      (parsed.length !== 1 && parsed.length !== 2) ||
      !parsed.every((part) => typeof part === "string")
    ) {
      return null;
    }
    return parsed as [string, string?];
  } catch {
    return null;
  }
}

/**
 * The invalidation epoch one `(scope, item)` preparation is retained under.
 *
 * Scope-wide and item-scoped counters are summed rather than compared, so
 * bumping either always moves the result and neither can mask the other
 * whatever order they arrive in. Both only ever count up.
 */
export function scopedEpoch(epochs: ScopedEpochState, scopeKey: string, itemId: string) {
  return (
    (epochs.get(scopedEpochKey(scopeKey)) ?? 0) +
    (epochs.get(scopedEpochKey(scopeKey, itemId)) ?? 0)
  );
}

/**
 * Invalidate prepared artifacts by bumping one epoch.
 *
 * Without `itemId` this retires every prepared artifact of the scope; with one
 * it retires only that item's, leaving the rest untouched.
 */
export function bumpScopedEpoch(
  current: ScopedEpochState,
  scopeKey: string,
  itemId?: string,
): ScopedEpochState {
  const key = scopedEpochKey(scopeKey, itemId);
  // A fresh map identity is the signal preparation watches; mutating in place would be invisible.
  const next = new Map(current);
  next.set(key, (current.get(key) ?? 0) + 1);
  return next;
}

/**
 * Drop epochs a reload orphaned, keeping map identity when nothing changed.
 *
 * A scoped entry outlives neither its scope nor the item it names: a reload
 * that drops either retires the entry with it.
 */
export function reconcileScopedEpochs(
  current: ScopedEpochState,
  itemIds: readonly string[],
  scopeKeys: ReadonlySet<string>,
): ScopedEpochState {
  if (current.size === 0) return current;
  const validItemIds = new Set(itemIds);
  const next = new Map<string, number>();
  for (const [key, epoch] of current) {
    const parsed = parseScopedEpochKey(key);
    if (!parsed) continue;
    const [scopeKey, itemId] = parsed;
    if (scopeKeys.has(scopeKey) && (itemId === undefined || validItemIds.has(itemId))) {
      next.set(key, epoch);
    }
  }
  return next.size === current.size ? current : next;
}
