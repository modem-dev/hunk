import type { AppBootstrap as CoreAppBootstrap } from "../core/types";
import type { ExtensionLoadResult } from "../extensions/types";

/** Interactive app bootstrap specialized with the extension host's session state. */
export type AppBootstrap = CoreAppBootstrap<ExtensionLoadResult>;
