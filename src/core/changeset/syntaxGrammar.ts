import { createHash } from "node:crypto";
import type { ExtensionSyntaxGrammar } from "../../extension-api/types";

/** One accepted custom grammar attributed to its owning extension. */
export interface SyntaxGrammarRegistration {
  extensionId: string;
  grammar: ExtensionSyntaxGrammar;
}

/** Immutable data handed to main-thread and worker highlighters. */
export interface SyntaxGrammarSnapshot {
  generation: number;
  digest: string;
  grammars: readonly ExtensionSyntaxGrammar[];
}

const EMPTY_DIGEST = createHash("sha256").update("[]").digest("hex");
let activeSnapshot: SyntaxGrammarSnapshot = Object.freeze({
  generation: 0,
  digest: EMPTY_DIGEST,
  grammars: Object.freeze([]),
});
const grammarChangeListeners = new Set<() => void>();

/** Subscribe a loaded worker adapter to grammar replacement without importing the UI into core. */
export function subscribeSyntaxGrammarChanges(listener: () => void) {
  grammarChangeListeners.add(listener);
  return () => grammarChangeListeners.delete(listener);
}

/** Notify loaded adapters synchronously so retired grammar data cannot remain executable. */
function notifyGrammarChange() {
  for (const listener of grammarChangeListeners) listener();
}

/** Hash normalized grammar data for cache identity and worker configuration. */
function grammarDigest(grammars: readonly ExtensionSyntaxGrammar[]) {
  return createHash("sha256").update(JSON.stringify(grammars)).digest("hex");
}

/** Replace all custom grammar data, invalidating consumers only when bytes changed. */
export function replaceExtensionSyntaxGrammars(
  registrations: readonly SyntaxGrammarRegistration[],
): SyntaxGrammarSnapshot {
  const grammars = Object.freeze(registrations.map(({ grammar }) => grammar));
  const digest = grammarDigest(grammars);
  if (digest === activeSnapshot.digest) return activeSnapshot;
  activeSnapshot = Object.freeze({
    generation: activeSnapshot.generation + 1,
    digest,
    grammars,
  });
  notifyGrammarChange();
  return activeSnapshot;
}

/** Restore grammar data captured before a failed session bootstrap. */
export function restoreSyntaxGrammars(snapshot: SyntaxGrammarSnapshot): void {
  if (snapshot.digest === activeSnapshot.digest) return;
  activeSnapshot = Object.freeze({
    generation: activeSnapshot.generation + 1,
    digest: snapshot.digest,
    grammars: snapshot.grammars,
  });
  notifyGrammarChange();
}

/** Return the active immutable grammar generation. */
export function syntaxGrammarSnapshot(): SyntaxGrammarSnapshot {
  return activeSnapshot;
}

/** Return whether a language id currently names a custom grammar. */
export function isCustomSyntaxLanguage(language: string | undefined): boolean {
  return activeSnapshot.grammars.some((grammar) => grammar.id === language);
}
