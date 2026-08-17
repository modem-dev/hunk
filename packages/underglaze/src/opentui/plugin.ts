/**
 * Packages a underglaze chrome layer as an OpenTUI plugin.
 *
 * OpenTUI's plugin system is a slot registry: a host app declares named slots,
 * plugins contribute Renderables into them, and the registry handles ordering,
 * replacement, disposal, and error isolation. This module builds one such
 * contribution whose Renderable is an `ImageRenderable` fed by underglaze's
 * rasterizer.
 *
 * Unlike `adapter.ts`, this file imports OpenTUI at runtime. It is reachable
 * only through the `underglaze/opentui` subpath, so a consumer drawing to a raw
 * stream never loads it and never needs the peer dependency installed.
 */
import {
  ImageRenderable,
  type CliRenderer,
  type CorePlugin,
  type RenderContext,
} from "@opentui/core";
import type { Surface } from "../scene/surface";
import { chromeIsWorthwhile, renderChromeLayer } from "./adapter";

export interface ChromePluginOptions {
  /** Plugin id, as the slot registry reports it in errors. */
  id?: string;
  /** Slot to contribute into; must match a slot the host app declares. */
  slot: string;
  /** Ordering hint within the slot; chrome usually wants to be first. */
  order?: number;
  /** Draws the chrome for a surface already sized to the current grid. */
  draw: (surface: Surface) => void;
  /**
   * Skips the layer when the terminal can only render it as block glyphs.
   *
   * Defaults to true. Two colors per cell is exactly what chrome cannot
   * survive, so a blocky gradient is usually worse than no gradient at all.
   */
  requireGraphics?: boolean;
  /** Pixel detail per cell. OpenTUI rescales to fit, so this trades size for sharpness. */
  cellWidth?: number;
  cellHeight?: number;
}

/** Reads the current grid size off the renderer, tolerating either accessor shape. */
function gridSize(renderer: CliRenderer): { cols: number; rows: number } {
  const candidate = renderer as unknown as {
    width?: number;
    height?: number;
    terminalWidth?: number;
    terminalHeight?: number;
  };
  return {
    cols: Math.max(1, Math.floor(candidate.width ?? candidate.terminalWidth ?? 80)),
    rows: Math.max(1, Math.floor(candidate.height ?? candidate.terminalHeight ?? 24)),
  };
}

export interface ChromePlugin<TSlot extends string> {
  plugin: CorePlugin<TSlot>;
  /**
   * Drops the cached layer so the next render re-rasterizes.
   *
   * Resizes are detected automatically; this is for the changes that are
   * invisible from the grid size, a theme switch being the usual one.
   */
  invalidate(): void;
}

/**
 * Builds a chrome plugin for a slot.
 *
 * The layer is re-rasterized whenever the grid size changes and cached
 * otherwise, because chrome is static between resizes; rebuilding per frame
 * would spend a PNG encode on identical output.
 */
export function createChromePlugin<TSlot extends string>(
  options: ChromePluginOptions,
): ChromePlugin<TSlot> {
  let cached: { source: Uint8Array; cols: number; rows: number } | null = null;
  let renderer: CliRenderer | null = null;

  const sourceFor = (cols: number, rows: number): Uint8Array => {
    if (cached && cached.cols === cols && cached.rows === rows) return cached.source;
    cached = renderChromeLayer(
      { cols, rows, cellWidth: options.cellWidth, cellHeight: options.cellHeight },
      options.draw,
    );
    return cached.source;
  };

  const renderSlot = (ctx: object): ImageRenderable => {
    const active = renderer;
    const capabilities = active
      ? ((active as unknown as { capabilities?: unknown }).capabilities ?? null)
      : null;
    const { cols, rows } = active ? gridSize(active) : { cols: 80, rows: 24 };

    // The registry expects a Renderable, so an unwanted layer still returns one
    // — an image with no source, which draws nothing.
    const wanted =
      options.requireGraphics === false ||
      chromeIsWorthwhile(capabilities as Parameters<typeof chromeIsWorthwhile>[0]);

    return new ImageRenderable(ctx as RenderContext, {
      source: wanted ? sourceFor(cols, rows) : undefined,
      fit: "fill",
    });
  };

  // Built by assignment rather than a computed-key literal: the slot name is only
  // known at runtime, so TypeScript cannot relate the literal to Record<TSlot, _>.
  const slots: CorePlugin<TSlot>["slots"] = {};
  slots[options.slot as TSlot] = renderSlot;

  const plugin: CorePlugin<TSlot> = {
    id: options.id ?? "underglaze-chrome",
    order: options.order ?? -100,
    setup(_ctx, cli) {
      renderer = cli;
    },
    dispose() {
      cached = null;
      renderer = null;
    },
    slots,
  };

  return {
    plugin,
    invalidate() {
      cached = null;
    },
  };
}
