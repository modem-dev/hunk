import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SessionTargetInput } from "./types";

export interface SelectableSession {
  sessionId: string;
  cwd: string;
  repoRoot?: string;
}

/** Return containment distance when a repo selector belongs to one session root. */
export function repoSelectorDistance(
  session: SelectableSession,
  selectorPath: string,
): number | null {
  if (!session.repoRoot) {
    return null;
  }

  const offset = relative(session.repoRoot, selectorPath);
  if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    return null;
  }

  return offset === "" ? 0 : offset.split(/[\\/]+/).filter(Boolean).length;
}

/** Return whether one session matches the selector precedence shared by the broker and CLI. */
export function matchesSessionSelector(
  session: SelectableSession,
  selector?: SessionTargetInput,
): boolean {
  if (!selector) {
    return true;
  }

  if (selector.sessionId) {
    return session.sessionId === selector.sessionId;
  }

  if (selector.sessionPath) {
    return session.cwd === selector.sessionPath;
  }

  if (selector.repoRoot) {
    return repoSelectorDistance(session, selector.repoRoot) !== null;
  }

  return true;
}

/** Resolve selector path fields into absolute paths before they cross the broker boundary. */
export function normalizeSessionSelector(selector: SessionTargetInput): SessionTargetInput {
  return {
    ...selector,
    sessionPath: selector.sessionPath ? resolve(selector.sessionPath) : undefined,
    repoRoot: selector.repoRoot ? resolve(selector.repoRoot) : undefined,
  };
}

/** Render one human-readable selector description for CLI messages. */
export function describeSessionSelector(selector: SessionTargetInput) {
  if (selector.sessionId) {
    return `session ${selector.sessionId}`;
  }

  if (selector.sessionPath) {
    return `session path ${selector.sessionPath}`;
  }

  if (selector.repoRoot) {
    return `repo ${selector.repoRoot}`;
  }

  return "session";
}
