import { describe, expect, test } from "bun:test";
import { hexColorDistance } from "../lib/color";
import { THEMES } from "../themes";
import type { ChromeSurfaces } from "./types";

/**
 * Pairs of surface levels that can appear directly adjacent in the UI and must
 * therefore stay visually distinct in borderless chrome (where no line separates
 * them). The numbers are minimum RGB distances; bands are deliberately subtle, so
 * the threshold only guards against two levels collapsing into the same shade.
 */
const ADJACENT_PAIRS: Array<[keyof ChromeSurfaces, keyof ChromeSurfaces]> = [
  ["code", "contextBand"], // gap/unchanged band sits in the code flow
  ["code", "sectionHeader"], // file header sits in the code flow
  ["contextBand", "sectionHeader"], // a gap band can sit right under a header
  ["code", "sidebar"], // sidebar adjoins the code pane
  ["code", "overlay"], // a popup floats over code
  ["sectionHeader", "overlay"], // a popup can float over a header
];

const MIN_DISTANCE = 6;

describe("chrome surface ladder", () => {
  for (const theme of THEMES) {
    test(`${theme.id} keeps adjacent surfaces distinct`, () => {
      for (const [a, b] of ADJACENT_PAIRS) {
        const distance = hexColorDistance(theme.surfaces[a], theme.surfaces[b]);
        expect(
          distance,
          `${theme.id}: surfaces.${a} and surfaces.${b} are too close (${distance.toFixed(1)})`,
        ).toBeGreaterThanOrEqual(MIN_DISTANCE);
      }
    });
  }
});
