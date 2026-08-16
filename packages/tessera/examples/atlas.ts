/**
 * Demonstrates what the atlas is for: one transmit, many placements.
 *
 * Run with `bun run examples/atlas.ts`. It packs a small chrome set, then
 * measures the wire cost of drawing forty elements two ways — as forty
 * separately transmitted images, and as one atlas plus forty placements.
 */
import { writeFileSync } from "node:fs";
import { AtlasBuilder, atlasOccupancy, spriteSource } from "../src/atlas/atlas";
import { encodePlace, encodeTransmit } from "../src/protocol/escapes";
import { linearGradient, solid, verticalGradient } from "../src/raster/paint";
import { encodePng } from "../src/raster/png";
import { cropPixmap } from "../src/raster/pixmap";
import { dropShadow } from "../src/raster/shadow";
import { fillPill, fillRoundRect, strokeRoundRect, topBevel } from "../src/raster/shapes";

const builder = new AtlasBuilder({ padding: 2, maxWidth: 512 });

// Status chips in three tones.
const tones: Array<[string, string, string]> = [
  ["chip-error", "#d25a5a", "#a03c3c"],
  ["chip-warn", "#e1aa46", "#b07c28"],
  ["chip-ok", "#6ebe82", "#3f8a58"],
];
for (const [name, from, to] of tones) {
  builder.add(name, 96, 26, (pm, rect) => {
    dropShadow(pm, rect, rect.height / 2, { dy: 2, blur: 3, opacity: 0.5 });
    fillPill(pm, rect, verticalGradient(from, to));
  });
}

// Panel corners and edges, the pieces a nine-slice needs.
builder.add("panel", 160, 96, (pm, rect) => {
  dropShadow(pm, rect, 14, { dx: 2, dy: 4, blur: 6, opacity: 0.6 });
  fillRoundRect(pm, rect, 14, verticalGradient("#2c2f3e", "#3c4052"));
  strokeRoundRect(pm, rect, 14, 1, solid("#78809f"));
  topBevel(pm, rect, 14, solid("#98a0c8"));
});

builder.add("track", 200, 20, (pm, rect) => fillPill(pm, rect, solid("#181920")));
builder.add("track-fill", 200, 20, (pm, rect) =>
  fillPill(
    pm,
    rect,
    linearGradient(
      [
        { offset: 0, color: "#78c896" },
        { offset: 1, color: "#46a06a" },
      ],
      90,
    ),
  ),
);
builder.add("title-bar", 320, 34, (pm, rect) => {
  fillRoundRect(pm, rect, 0, verticalGradient("#343a5c", "#1c1f31"));
  topBevel(pm, rect, 0, solid("#8c96c8"));
});

const atlas = builder.bake();
const atlasPng = encodePng(atlas.pixmap);
writeFileSync(new URL("atlas.png", import.meta.url), atlasPng);

const b64 = (n: number) => Math.ceil(n / 3) * 4;
const kb = (n: number) => `${(n / 1024).toFixed(1)}K`;

// Draw forty elements, cycling through the sprite set.
const names = [...atlas.sprites.keys()];
const DRAWS = 40;

// Path A: every element transmitted as its own image.
let separate = 0;
for (let i = 0; i < DRAWS; i++) {
  const sprite = atlas.sprites.get(names[i % names.length]!)!;
  const cropped = cropPixmap(atlas.pixmap, sprite.x, sprite.y, sprite.width, sprite.height);
  const png = encodePng(cropped);
  separate += encodeTransmit(png, { id: i + 10, format: 100 }).reduce(
    (s, seq) => s + seq.length,
    0,
  );
  separate += encodePlace({ id: i + 10, cols: 12, rows: 2, z: -1, keepCursor: true }).length;
}

// Path B: the atlas once, then a placement per element.
let atlased = encodeTransmit(atlasPng, { id: 1, format: 100 }).reduce(
  (s, seq) => s + seq.length,
  0,
);
for (let i = 0; i < DRAWS; i++) {
  atlased += encodePlace({
    id: 1,
    ...spriteSource(atlas, names[i % names.length]!),
    cols: 12,
    rows: 2,
    z: -1,
    keepCursor: true,
  }).length;
}

console.log(
  `atlas          : ${atlas.pixmap.width}x${atlas.pixmap.height}px, ${atlas.sprites.size} sprites`,
);
console.log(`occupancy      : ${(atlasOccupancy(atlas) * 100).toFixed(1)}%`);
console.log(`atlas png      : ${kb(atlasPng.length)} (${kb(b64(atlasPng.length))} base64)`);
console.log("");
console.log(`${DRAWS} draws, separate images : ${kb(separate)}`);
console.log(`${DRAWS} draws, one atlas       : ${kb(atlased)}`);
console.log(`saving                     : ${(separate / atlased).toFixed(1)}x`);
console.log("");
console.log("wrote examples/atlas.png");
