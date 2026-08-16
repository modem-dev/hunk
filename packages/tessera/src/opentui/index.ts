/**
 * OpenTUI integration for tessera.
 *
 * Kept behind its own entry point because it is the one part of the library
 * that needs OpenTUI present. Importing `tessera` never reaches this module, so
 * the peer dependency stays genuinely optional.
 */
export {
  chromeIsWorthwhile,
  fromOpenTuiCapabilities,
  pixmapToImageSource,
  renderChromeLayer,
  toImageSource,
} from "./adapter";
export type { ChromeLayerOptions } from "./adapter";
export { createChromePlugin } from "./plugin";
export type { ChromePlugin, ChromePluginOptions } from "./plugin";
