/**
 * tessera — pixel-accurate chrome for terminals, with honest fallbacks.
 *
 * The public surface is grouped in tiers so consumers can enter at whatever
 * level they need: draw with `Surface`, target a specific `Backend`, rasterize
 * by hand into a `Pixmap`, or drop all the way down to protocol encoding.
 */

// Drawing
export { createSurface, Surface, autoBackend } from "./scene/surface";
export type { CellRect, PanelStyle, SurfaceOptions } from "./scene/surface";

// Backends
export { blocksBackend } from "./backend/blocks";
export type { BlockStyle } from "./backend/blocks";
export { imageBackend } from "./backend/image";
export type { ImageBackendOptions } from "./backend/image";
export { clearAllImages, kittyBackend } from "./backend/kitty";
export type { KittyBackendOptions } from "./backend/kitty";
export { DEFAULT_CELL_GEOMETRY, pixelSize } from "./backend/types";
export type { Backend, CellGeometry, RenderOutput } from "./backend/types";

// Capability
export { chooseSourceScale, detectCapability } from "./capability/detect";
export type { GraphicsSupport, MagnificationFilter, TerminalCapability } from "./capability/detect";

// Raster
export {
  linearGradient,
  mix,
  over,
  parseColor,
  radialGradient,
  solid,
  verticalGradient,
  withAlpha,
} from "./raster/paint";
export type { ColorInput, GradientStop, Paint, Rgba } from "./raster/paint";
export { encodeDeflatedRgba, encodePng, encodeSmallest } from "./raster/png";
export {
  clonePixmap,
  createPixmap,
  cropPixmap,
  downscale,
  blendPixel,
  fillAll,
  getPixel,
  setPixel,
} from "./raster/pixmap";
export type { Pixmap } from "./raster/pixmap";
export { dropShadow } from "./raster/shadow";
export type { ShadowOptions } from "./raster/shadow";
export {
  coverageFromDistance,
  fillPill,
  fillRect,
  fillRoundRect,
  roundRectCoverage,
  roundRectDistance,
  strokeRoundRect,
  topBevel,
} from "./raster/shapes";
export type { Rect } from "./raster/shapes";

// Protocol
export {
  chunkBase64,
  encodeDelete,
  encodePlace,
  encodeSupportQuery,
  encodeTransmit,
  MAX_CHUNK_BYTES,
} from "./protocol/escapes";
export type {
  DeleteScope,
  PlacementOptions,
  Quietness,
  TransmitFormat,
  TransmitMedium,
  TransmitOptions,
} from "./protocol/escapes";
export { fitsPlaceholderGrid, placeholderRows, PLACEHOLDER_CHAR } from "./protocol/placeholder";
export type { PlaceholderOptions } from "./protocol/placeholder";
export {
  detectMultiplexer,
  wrapForMultiplexer,
  wrapScreen,
  wrapTmux,
} from "./protocol/passthrough";
export type { Multiplexer } from "./protocol/passthrough";
export { MAX_PLACEHOLDER_INDEX } from "./protocol/diacritics";

// Atlas
export { AtlasBuilder, atlasOccupancy, spriteRect, spriteSource } from "./atlas/atlas";
export type { AtlasOptions, BakedAtlas, Sprite, SpriteDraw } from "./atlas/atlas";
