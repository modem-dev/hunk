import type { HunkConfigResolution } from "../run/config";
import type { OpenCommandInput } from "../run/commandInputs";
import type { InteractiveSessionInitialization } from "../session/initialization";
import type { DocumentSource } from "./source";

/** Carry finalized document capabilities and preferences across startup and presentation tiers. */
export interface DocumentBrowserBootstrap {
  source: DocumentSource;
  configured: HunkConfigResolution<OpenCommandInput>;
  initialization: InteractiveSessionInitialization;
}
