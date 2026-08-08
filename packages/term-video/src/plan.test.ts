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
