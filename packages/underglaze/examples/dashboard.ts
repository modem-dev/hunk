/**
 * Draws one scene and reports what each backend does with it.
 *
 * Run with `bun run examples/dashboard.ts`. In a graphics-capable terminal it
 * paints the chrome; anywhere else it falls back to block glyphs. Either way it
 * writes `dashboard.png` so the intended output can be inspected, and prints the
 * wire cost of each path so the tradeoff is visible rather than asserted.
 */
import { writeFileSync } from "node:fs";
import { blocksBackend } from "../src/backend/blocks";
import { kittyBackend } from "../src/backend/kitty";
import { detectCapability } from "../src/capability/detect";
import { linearGradient, verticalGradient } from "../src/raster/paint";
import { autoBackend, createSurface } from "../src/scene/surface";

const COLS = 80;
const ROWS = 24;

const surface = createSurface({ cols: COLS, rows: ROWS, background: "#14151a" });

// Title bar: a vertical ramp with a bright top bevel, the classic raised edge.
surface.panel(
  { x: 0, y: 0, width: COLS, height: 2 },
  { fill: verticalGradient("#343a5c", "#1c1f31"), bevel: "#8c96c8" },
);

// Sidebar, with one selected row drawn as a glossy capsule.
surface.panel(
  { x: 0, y: 2, width: 20, height: ROWS - 3 },
  { fill: verticalGradient("#1e202c", "#242634") },
);
surface.pill(
  { x: 0.5, y: 4, width: 19, height: 1 },
  {
    fill: linearGradient([
      { offset: 0, color: "#6f8fd8" },
      { offset: 1, color: "#4664b4" },
    ]),
  },
);

// Main panel: soft shadow, gradient fill, hairline border.
surface.panel(
  { x: 22, y: 3, width: 56, height: 18 },
  {
    radius: 14,
    fill: verticalGradient("#2c2f3e", "#3c4052"),
    border: { color: "#78809f" },
    shadow: { dx: 3, dy: 6, blur: 7, opacity: 0.75 },
  },
);

surface.meter({ x: 25, y: 10, width: 50, height: 1.2 }, 0.62, {
  fill: verticalGradient("#78c896", "#46a06a"),
});

const chips: Array<[number, string, string]> = [
  [25, "#d25a5a", "#a03c3c"],
  [40, "#e1aa46", "#b07c28"],
  [55, "#6ebe82", "#3f8a58"],
];
for (const [x, from, to] of chips) {
  surface.pill(
    { x, y: 14, width: 12, height: 1.5 },
    { fill: verticalGradient(from, to), shadow: { dy: 2, blur: 3, opacity: 0.5 } },
  );
}

// Status bar.
surface.panel(
  { x: 0, y: ROWS - 1, width: COLS, height: 1 },
  { fill: verticalGradient("#2a2c3a", "#20222e"), bevel: "#666e92" },
);

const capability = detectCapability();
const blocks = surface.toTerminal(blocksBackend("half"));
const kitty = surface.toTerminal(kittyBackend({ capability, replace: true }));
const png = surface.toPng();

writeFileSync(new URL("dashboard.png", import.meta.url), png);

const kb = (n: number) => `${(n / 1024).toFixed(1)}K`;
console.error(`terminal   : ${capability.terminal} (graphics: ${capability.graphics})`);
console.error(`kitty path : ${kb(kitty.length)} on the wire`);
console.error(`blocks path: ${kb(blocks.length)} on the wire`);
console.error(`png written: ${kb(png.length)} -> examples/dashboard.png`);

// Paint the scene using whichever backend suits this terminal.
process.stdout.write(surface.toTerminal(autoBackend(capability)));
process.stdout.write("\n");
