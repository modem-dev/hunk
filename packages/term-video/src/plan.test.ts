import { describe, expect, test } from "bun:test";
import { planFrames, requiredKeyframes, type Shot } from "./plan.mjs";

const FPS = 30;

function term(overrides: Partial<Shot> = {}): Shot {
  return { kind: "term", img: "frame-a", title: "t", dur: 2, ...overrides };
}

describe("planFrames", () => {
  test("a captioned shot animates its caption in, then holds", () => {
    const { frames } = planFrames([term({ caption: "hello", capKey: "a" })], { fps: FPS });

    const animFrames = Math.round(0.45 * FPS);
    expect(frames).toHaveLength(animFrames + 1);
    expect(frames[0]!.state).toMatchObject({ caption: "hello", capT: 1 / animFrames });
    expect(frames.at(-1)!.state).toMatchObject({ capT: 1 });
    expect(frames.at(-1)!.duration).toBeCloseTo(2 - animFrames / FPS, 5);
  });

  test("continuation shots sharing a capKey keep the caption without re-animating", () => {
    const { frames } = planFrames(
      [
        term({ caption: "walking", capKey: "walk", dur: 1 }),
        term({ img: "frame-b", capKey: "walk", dur: 0.2 }),
      ],
      { fps: FPS },
    );

    const continuation = frames.at(-1)!;
    expect(continuation.state).toMatchObject({ img: "frame-b", caption: "walking", capT: 1 });
    // No animation frames were added for the continuation shot.
    expect(frames.filter((frame) => frame.state.img === "frame-b")).toHaveLength(1);
  });

  test("a changed capKey animates the new caption in", () => {
    const { frames } = planFrames(
      [
        term({ caption: "first", capKey: "one", dur: 1 }),
        term({ img: "frame-b", caption: "second", capKey: "two", dur: 1 }),
      ],
      { fps: FPS },
    );

    const secondShotFrames = frames.filter((frame) => frame.state.img === "frame-b");
    expect(secondShotFrames.length).toBeGreaterThan(1);
    expect(secondShotFrames[0]!.state.capT).toBeLessThan(1);
  });

  test("cards reset caption state so the next terminal caption animates", () => {
    const { frames } = planFrames(
      [
        term({ caption: "before", capKey: "same", dur: 1 }),
        { kind: "card", html: "<h1>x</h1>", dur: 1, enter: true },
        term({ img: "frame-b", caption: "before", capKey: "same", dur: 1 }),
      ],
      { fps: FPS },
    );

    const afterCard = frames.filter((frame) => frame.state.img === "frame-b");
    expect(afterCard[0]!.state.capT).toBeLessThan(1);
  });

  test("enter animates shotT while short durations clamp the animation window", () => {
    const { frames } = planFrames([term({ enter: true, dur: 0.3 })], { fps: FPS });

    // Animation window is capped at 60% of the shot, not the full 0.45s.
    const animFrames = Math.round(0.3 * 0.6 * FPS);
    expect(frames).toHaveLength(animFrames + 1);
    expect(frames[0]!.state.shotT).toBeLessThan(1);
  });

  test("animates camera pans and source-aligned highlights before holding", () => {
    const camera = { x: 0.25, y: 0.4, scale: 1.5 };
    const highlight = { x: 0.1, y: 0.2, width: 0.7, height: 0.3, label: "history" };
    const { frames } = planFrames([term({ camera, highlight, motion: 0.6 })], { fps: FPS });

    expect(frames).toHaveLength(Math.round(0.6 * FPS) + 1);
    expect(frames[0]!.state.camera!.scale).toBeGreaterThan(1);
    expect(frames[0]!.state.camera!.scale).toBeLessThan(camera.scale);
    expect(frames[0]!.state.highlight).toEqual(highlight);
    expect(frames[0]!.state.highlightT).toBeGreaterThan(0);
    expect(frames[0]!.state.highlightT).toBeLessThan(1);
    expect(frames.at(-1)!.state).toMatchObject({ camera, highlight, highlightT: 1 });
  });

  test("does not carry a source-aligned highlight onto a different keyframe", () => {
    const highlight = { x: 0.1, y: 0.2, width: 0.7, height: 0.3 };
    const { frames } = planFrames(
      [term({ highlight, motion: 0.3 }), term({ img: "frame-b", motion: 0.3 })],
      { fps: FPS },
    );

    const clearingFrames = frames.filter((frame) => frame.state.img === "frame-b");
    expect(clearingFrames).toHaveLength(1);
    expect(clearingFrames[0]!.state).toMatchObject({ highlight: null, highlightT: 0 });
  });

  test("cuts to the target camera when a keyframe has incompatible source geometry", () => {
    const firstCamera = { x: 0.25, y: 0.4, scale: 1.5 };
    const targetCamera = { x: 0.5, y: 0.5, scale: 1 };
    const { frames } = planFrames(
      [term({ camera: firstCamera, dur: 0.5 }), term({ img: "frame-b", camera: targetCamera })],
      { fps: FPS },
    );

    const secondFrames = frames.filter((frame) => frame.state.img === "frame-b");
    expect(secondFrames).toHaveLength(1);
    expect(secondFrames[0]!.state.camera).toEqual(targetCamera);
  });

  test("pans across keyframes that share a camera coordinate-space key", () => {
    const firstCamera = { x: 0.25, y: 0.4, scale: 1.5 };
    const targetCamera = { x: 0.5, y: 0.5, scale: 1 };
    const { frames } = planFrames(
      [
        term({ camera: firstCamera, cameraKey: "history", dur: 0.5 }),
        term({ img: "frame-b", camera: targetCamera, cameraKey: "history", motion: 0.3 }),
      ],
      { fps: FPS },
    );

    const secondFrames = frames.filter((frame) => frame.state.img === "frame-b");
    expect(secondFrames.length).toBeGreaterThan(1);
    expect(secondFrames[0]!.state.camera!.scale).toBeLessThan(firstCamera.scale);
    expect(secondFrames[0]!.state.camera!.scale).toBeGreaterThan(targetCamera.scale);
    expect(secondFrames.at(-1)!.state.camera).toEqual(targetCamera);
  });

  test("morphs highlights across keyframes that share a coordinate-space key", () => {
    const first = { x: 0.1, y: 0.2, width: 0.7, height: 0.2 };
    const second = { ...first, height: 0.5 };
    const { frames } = planFrames(
      [
        term({ highlight: first, highlightKey: "history", motion: 0.3 }),
        term({ img: "frame-b", highlight: second, highlightKey: "history", motion: 0.3 }),
      ],
      { fps: FPS },
    );

    const secondFrames = frames.filter((frame) => frame.state.img === "frame-b");
    expect(secondFrames[0]!.state.highlight!.height).toBeGreaterThan(first.height);
    expect(secondFrames[0]!.state.highlight!.height).toBeLessThan(second.height);
    expect(secondFrames.at(-1)!.state.highlight).toEqual(second);
  });

  test("every hold lasts at least one frame and totals match the shot list", () => {
    const shots = [
      term({ caption: "a", capKey: "a", dur: 1.5 }),
      term({ img: "frame-b", capKey: "a", dur: 0.01 }),
    ];
    const { frames, totalSeconds } = planFrames(shots, { fps: FPS });

    for (const frame of frames) {
      expect(frame.duration).toBeGreaterThanOrEqual(1 / FPS - 1e-9);
    }
    // The under-length shot is padded up to one frame, so the total can only
    // exceed the declared durations, never undercut them.
    expect(totalSeconds).toBeGreaterThanOrEqual(1.5 + 0.01 - 1e-9);
  });
});

describe("requiredKeyframes", () => {
  test("lists each terminal image once, ignoring cards", () => {
    const names = requiredKeyframes([
      term({ img: "one" }),
      term({ img: "two" }),
      term({ img: "one" }),
      { kind: "card", html: "<h1>x</h1>", dur: 1 },
    ]);
    expect(names).toEqual(["one", "two"]);
  });
});
