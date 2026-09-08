import { createVcsCatalog } from "../core/vcs";
import type { VcsCatalog } from "../core/vcs/types";
import { getBundledVcsAdapters } from "../extensions/default/vcs";

/** Product fallback provider selected when config names no backend. */
const DEFAULT_VCS_ID = "git";

let bundledCatalog: VcsCatalog | undefined;

/** Compose Hunk's statically bundled adapters at the app boundary. */
export function getBundledVcsCatalog(): VcsCatalog {
  bundledCatalog ??= createVcsCatalog(getBundledVcsAdapters(), DEFAULT_VCS_ID);
  return bundledCatalog;
}
