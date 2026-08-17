/**
 * Packs many small sprites into one image.
 *
 * Transmission is the expensive part of drawing with the graphics protocol and
 * placement is nearly free, so the efficient shape is one image sent once plus a
 * placement per element selecting a source rectangle out of it. This module owns
 * that packing: callers declare sprites by name and size, draw into whatever
 * rectangle they are assigned, and later ask for the rectangle back.
 *
 * Packing is shelf-based — sprites sorted tall-first, laid out in rows. It is
 * not optimal, but chrome atlases hold tens of sprites rather than thousands,
 * and shelf packing wastes little on the wide-and-short shapes UI is made of.
 */
import { createPixmap, type Pixmap } from "../raster/pixmap";
import type { Rect } from "../raster/shapes";

/** A sprite's location within the baked atlas, in pixels. */
export interface Sprite {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Draws one sprite into the atlas at the rectangle it was assigned. */
export type SpriteDraw = (pixmap: Pixmap, rect: Rect) => void;

interface PendingSprite {
  name: string;
  width: number;
  height: number;
  draw: SpriteDraw;
}

export interface AtlasOptions {
  /** Transparent gap between sprites, so scaling cannot bleed a neighbour in. */
  padding?: number;
  /** Upper bound on atlas width; sprites wrap to a new shelf past it. */
  maxWidth?: number;
}

/** A packed atlas: the image plus where everything landed. */
export interface BakedAtlas {
  pixmap: Pixmap;
  sprites: ReadonlyMap<string, Sprite>;
}

/**
 * Collects sprite declarations and packs them on `bake`.
 *
 * Sizes must be known at declaration time, but drawing is deferred until the
 * layout is known, which is what lets a sprite be drawn directly into its final
 * position instead of being rasterized separately and copied in.
 */
export class AtlasBuilder {
  private readonly pending: PendingSprite[] = [];
  private readonly names = new Set<string>();
  private readonly padding: number;
  private readonly maxWidth: number;

  constructor(options: AtlasOptions = {}) {
    this.padding = Math.max(0, Math.floor(options.padding ?? 1));
    this.maxWidth = Math.max(1, Math.floor(options.maxWidth ?? 1024));
  }

  /** Declares a sprite. Names must be unique, since they are the lookup key. */
  add(name: string, width: number, height: number, draw: SpriteDraw): this {
    if (this.names.has(name)) throw new Error(`duplicate sprite name: ${name}`);
    if (width <= 0 || height <= 0) {
      throw new Error(`sprite "${name}" must be non-empty, got ${width}x${height}`);
    }
    if (width > this.maxWidth) {
      throw new Error(
        `sprite "${name}" is ${width}px wide, over the ${this.maxWidth}px atlas limit`,
      );
    }
    this.names.add(name);
    this.pending.push({ name, width: Math.ceil(width), height: Math.ceil(height), draw });
    return this;
  }

  /** Number of sprites declared so far. */
  get size(): number {
    return this.pending.length;
  }

  /**
   * Packs and rasterizes every declared sprite.
   *
   * Sprites are placed tall-first so each shelf is filled by items of similar
   * height, which is what keeps the wasted strip above short sprites small.
   */
  bake(): BakedAtlas {
    if (this.pending.length === 0) throw new Error("cannot bake an empty atlas");

    const ordered = [...this.pending].sort((a, b) => b.height - a.height || b.width - a.width);
    const placements: Sprite[] = [];
    let shelfY = this.padding;
    let shelfHeight = 0;
    let cursorX = this.padding;
    let usedWidth = 0;

    for (const sprite of ordered) {
      // Start a new shelf when this sprite would overflow the current row.
      if (cursorX + sprite.width + this.padding > this.maxWidth && cursorX > this.padding) {
        shelfY += shelfHeight + this.padding;
        shelfHeight = 0;
        cursorX = this.padding;
      }
      placements.push({
        name: sprite.name,
        x: cursorX,
        y: shelfY,
        width: sprite.width,
        height: sprite.height,
      });
      cursorX += sprite.width + this.padding;
      usedWidth = Math.max(usedWidth, cursorX);
      shelfHeight = Math.max(shelfHeight, sprite.height);
    }

    const pixmap = createPixmap(usedWidth, shelfY + shelfHeight + this.padding);
    const sprites = new Map<string, Sprite>();
    const drawByName = new Map(this.pending.map((s) => [s.name, s.draw]));
    for (const placed of placements) {
      sprites.set(placed.name, placed);
      const draw = drawByName.get(placed.name);
      draw?.(pixmap, { x: placed.x, y: placed.y, width: placed.width, height: placed.height });
    }
    return { pixmap, sprites };
  }
}

/** Looks a sprite up, failing loudly rather than drawing the wrong rectangle. */
export function spriteRect(atlas: BakedAtlas, name: string): Sprite {
  const sprite = atlas.sprites.get(name);
  if (!sprite) throw new Error(`unknown sprite: ${name}`);
  return sprite;
}

/**
 * Builds the source-rectangle keys that place one sprite from the atlas.
 *
 * Spreading the result into `encodePlace` alongside an image id and a
 * destination box is the whole draw call for an atlas-backed element.
 */
export function spriteSource(
  atlas: BakedAtlas,
  name: string,
): { srcX: number; srcY: number; srcW: number; srcH: number } {
  const sprite = spriteRect(atlas, name);
  return { srcX: sprite.x, srcY: sprite.y, srcW: sprite.width, srcH: sprite.height };
}

/** Fraction of the atlas actually covered by sprites, for tuning packing. */
export function atlasOccupancy(atlas: BakedAtlas): number {
  let used = 0;
  for (const sprite of atlas.sprites.values()) used += sprite.width * sprite.height;
  const total = atlas.pixmap.width * atlas.pixmap.height;
  return total === 0 ? 0 : used / total;
}
