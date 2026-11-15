import { describe, expect, test } from "bun:test";
import { StreamMeasurements } from "./streamMeasurements";

describe("StreamMeasurements", () => {
  // Intent: the render that first sees a new layout must already read empty measurements,
  // because nothing re-renders the stream after a later clear.
  test("drops heights and geometry as soon as the layout or wrapping changes", () => {
    const measurements = new StreamMeasurements<number>("split", false);
    measurements.heights.set("file:a", 300);
    measurements.geometries.set("file:a", 1);

    expect(measurements.sync("split", false)).toBe(false);
    expect(measurements.heights.get("file:a")).toBe(300);

    expect(measurements.sync("unified", false)).toBe(true);
    expect(measurements.heights.size).toBe(0);
    expect(measurements.geometries.size).toBe(0);

    measurements.heights.set("file:a", 200);
    expect(measurements.sync("unified", true)).toBe(true);
    expect(measurements.heights.size).toBe(0);
  });

  test("forgets one file's geometry without touching its height", () => {
    const measurements = new StreamMeasurements<number>("split", false);
    measurements.heights.set("file:a", 300);
    measurements.geometries.set("file:a", 1);
    measurements.geometries.set("file:b", 2);

    measurements.dropGeometry("file:a");

    expect([...measurements.geometries.keys()]).toEqual(["file:b"]);
    expect(measurements.heights.get("file:a")).toBe(300);
  });
});
