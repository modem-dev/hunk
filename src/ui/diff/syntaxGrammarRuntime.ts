import { syntaxGrammarSnapshot } from "../../core/changeset/syntaxGrammar";

/** Return the grammar digest used by rendered-result caches. */
export function activeSyntaxGrammarDigest() {
  return syntaxGrammarSnapshot().digest;
}
