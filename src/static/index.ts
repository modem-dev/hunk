import type { StaticDiffOptions } from "./types.js";

export type { StaticDiffOptions } from "./types.js";

type StaticRenderer = typeof import("../ui/staticDiffPager");

let rendererPromise: Promise<StaticRenderer> | undefined;

/** Load Pierre-backed rendering after providing the browser metadata its root entry expects. */
function loadRenderer() {
  rendererPromise ??= (async () => {
    const runtime = globalThis as typeof globalThis & {
      navigator?: Pick<Navigator, "maxTouchPoints" | "platform" | "userAgent">;
    };
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(runtime, "navigator");
    if (runtime.navigator === undefined) {
      Object.defineProperty(runtime, "navigator", {
        configurable: true,
        value: {
          maxTouchPoints: 0,
          platform: "",
          userAgent: "",
        },
      });
    }

    try {
      return await import("../ui/staticDiffPager");
    } finally {
      if (navigatorDescriptor) {
        Object.defineProperty(runtime, "navigator", navigatorDescriptor);
      } else {
        Reflect.deleteProperty(runtime, "navigator");
      }
    }
  })();
  return rendererPromise;
}

/** Render a unified patch as ANSI text without starting Hunk's interactive application. */
export async function renderStaticDiff(text: string, options: StaticDiffOptions = {}) {
  const { renderStaticDiff: render } = await loadRenderer();
  return render(text, options);
}
