# underglaze

Pixel-accurate chrome for terminals, with honest fallbacks.

Terminals can draw real pixels. The kitty graphics protocol lets a program transmit an image and
place it under the text layer, so gradients, rounded corners, bevels and soft shadows render as
actual pixels while the terminal keeps drawing selectable text on top. `underglaze` is the rendering
core for that: you issue draw calls in cell coordinates, and it produces escape sequences, block
glyphs, or a PNG.

It is not a UI framework. There is no layout engine, component model, or event handling — it slots
into OpenTUI, Ink, ratatui-style loops, or raw stdout rather than competing with them.

The name is the technique: in ceramics, underglaze decoration is painted onto the body and then
fired _beneath_ the clear glaze, so it shows through the surface without ever being on it. That is
what a negative z-index does here — the chrome goes under, the text stays on top and stays text.

## Why images instead of block glyphs

A terminal cell can show exactly two colors: one foreground, one background. Richer glyph sets buy
more subcell _shapes_ — halves, quadrants, sextants, octants — but never a third color. A smooth
corner or a soft shadow cannot be represented at any glyph density.

The wire cost runs the opposite way to intuition. Measured on an 80×24 grid at 8×17px:

| content              |           half-block text |          filtered PNG |
| -------------------- | ------------------------: | --------------------: |
| full-screen gradient |     72.2K, visibly banded | **9.6K, pixel-exact** |
| flat panel chrome    | 8.8K, corners squared off | **3.1K, pixel-exact** |

Truecolor SGR costs roughly 30 bytes per cell, and a repaint pays it for every cell that changed.
An image pays once and places cheaply. Text rendering is itself a lossy image codec — a fixed 1×2
downsample in a verbose container — so for synthetic UI graphics the image is both smaller and
correct.

Photographic content inverts this: PNG has no lossy mode and JPEG is not an accepted format, so
photos are the case where blocks legitimately win on bytes.

## Usage

```ts
import { createSurface, verticalGradient, autoBackend } from "underglaze";

const surface = createSurface({ cols: 80, rows: 24, background: "#14151a" });

surface.panel(
  { x: 22, y: 3, width: 56, height: 18 },
  {
    radius: 14,
    fill: verticalGradient("#2c2f3e", "#3c4052"),
    border: { color: "#78809f" },
    shadow: { dx: 3, dy: 6, blur: 7 },
  },
);

surface.meter({ x: 25, y: 10, width: 50, height: 1.2 }, 0.62);

process.stdout.write(surface.toTerminal(autoBackend()));
```

Coordinates are in cells, including fractional ones. Radii, blurs and offsets are in pixels, since
that is how they read.

## Backends

One scene, three targets:

```ts
surface.toTerminal(kittyBackend()); // graphics protocol
surface.toTerminal(blocksBackend("half")); // two colors per cell
surface.toPng(2); // PNG bytes, magnified 2x
```

The PNG target is what makes terminal UI snapshot-testable. Asserting on escape sequences proves
what was _sent_; rendering the same scene to an image gives you something a human can open and a
test can diff, with no PTY and no screenshot harness.

`autoBackend()` picks graphics only for a terminal confirmed to support them. Anything unrecognized
falls back to blocks, because emitting a graphics sequence to a terminal that does not understand it
dumps base64 across the screen — a far worse failure than degraded chrome.

## Capability detection, and one thing that cannot be detected

`detectCapability()` identifies the terminal from its environment and reports graphics support,
multiplexer, and true-color availability. A multiplexer downgrades confident support to `unknown`,
since whether tmux permits passthrough is a runtime config question the environment does not answer.

One field is deliberately always `unknown`: **`magnification`**, how the terminal resamples an image
scaled up to fill its cell box. Transmitting a reduced-resolution source and letting the terminal
enlarge it is worth roughly 10× on the wire, but only under a smooth filter; under nearest-neighbour
it looks worse than the block fallback it was meant to beat. This cannot be probed. The protocol
neither documents the filter nor offers a key to select one, and a program cannot read rendered
pixels back through the pty. So `chooseSourceScale()` returns 1 — native resolution — unless a
caller supplies confirmed knowledge about a specific terminal.

## Layout

```
protocol/   escape encoding, chunking, placeholders, multiplexer passthrough — pure strings
capability/ terminal identification and what can be trusted
raster/     pixmap, paints, SDF shapes, shadows, PNG encoder — no terminal knowledge
backend/    kitty / blocks / image render targets
scene/      the Surface consumers draw into
```

Dependency-free apart from `node:zlib`. The PNG encoder is about 120 lines and uses adaptive
scanline filtering, which is not optional: on a gradient, filtered PNG came out roughly twelve times
smaller than the same pixels deflated raw.

## Sprite atlas

Transmission is expensive and placement is nearly free, so the efficient shape is one image sent
once plus a placement per element selecting a source rectangle out of it.

```ts
const atlas = new AtlasBuilder({ padding: 2 })
  .add("chip-ok", 96, 26, (pm, rect) => fillPill(pm, rect, verticalGradient("#6ebe82", "#3f8a58")))
  .add("panel", 160, 96, (pm, rect) => {
    /* … */
  })
  .bake();

encodePlace({ id: 1, ...spriteSource(atlas, "chip-ok"), cols: 12, rows: 2, z: -1 });
```

Sizes are declared up front and drawing is deferred until packing is done, so each sprite is drawn
straight into its final position rather than rasterized separately and copied in. Measured by
`examples/atlas.ts` — 40 elements from a 7-sprite atlas:

| approach                         | wire cost |
| -------------------------------- | --------: |
| 40 separately transmitted images |     47.0K |
| one atlas + 40 placements        | **11.4K** |

## OpenTUI

`underglaze/opentui` is a separate entry point with `@opentui/core` as an optional peer dependency.

**It deliberately does not use underglaze's own protocol, capability, or blocks backends.** OpenTUI
already owns everything below the pixels: it probes `kitty_graphics` at runtime rather than sniffing
environment variables, decodes and resizes natively, and falls back across kitty, sixel and blocks
on its own. Reimplementing that under OpenTUI would be a second, worse copy. What OpenTUI has no
equivalent for is a rasterizer — nothing in it draws a gradient, a rounded corner, or a shadow.

So: **underglaze draws, OpenTUI delivers.** The seam is PNG bytes, which is `ImageRenderable`'s public
`source` type.

```ts
import { renderChromeLayer, chromeIsWorthwhile } from "underglaze/opentui";

const layer = renderChromeLayer({ cols, rows }, (surface) => {
  surface.panel({ x: 2, y: 1, width: 36, height: 9 }, { radius: 12, shadow: { dy: 3, blur: 5 } });
});

// then, in React:  <image source={layer.source} fit="fill" />
```

As an actual plugin, contributed into a host app's slot registry:

```ts
const { plugin, invalidate } = createChromePlugin({
  slot: "background",
  draw: (surface) => surface.panel(/* … */),
});
registerCorePlugin(registry, plugin);
```

The layer is cached and re-rasterized only when the grid size changes; call `invalidate()` for the
changes a resize cannot reveal, such as a theme switch. `chromeIsWorthwhile()` reports whether the
terminal can render pixels at all — when it can only manage block glyphs the plugin draws nothing,
since a blocky gradient is usually worse than a plain box border.

## Status

Early. Drawing covers panels, pills, meters, borders, bevels and shadows, plus atlas packing.
Nine-slice scaling and image-file decoding are not implemented — under OpenTUI, `NativeImage`
already covers decoding. Unicode placeholder cells are implemented and tested but have not been
exercised against a live terminal.

```
bun test                        # 119 tests
bun run examples/dashboard.ts
bun run examples/atlas.ts
```
