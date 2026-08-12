import { describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { prepareStartupPlan } from "../app/startup";
import type { HunkConfigResolution } from "../core/config";
import { loadAppBootstrap } from "../core/loaders";
import type { CliInput } from "../core/types";
import { createEmptyExtensionLoadResult } from "../extensions/types";
import { AppHost } from "./AppHost";

/** Flush effects and OpenTUI rendering until the public frame reflects current state. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

describe("bundled tutor", () => {
  test("renders one focused step with the user's live command binding", async () => {
    const input: CliInput = {
      kind: "tutor",
      options: { mode: "stack", theme: "hunk-tutor" },
    };
    const configured: HunkConfigResolution = {
      input,
      customThemes: [],
      extensions: { enabled: false, paths: [], repoPaths: [], extensionConfigs: {} },
      keybindings: { "hunk.app.toggleHelp": "ctrl+h" },
    };
    const extensions = createEmptyExtensionLoadResult();
    const plan = await prepareStartupPlan(["bun", "hunk", "tutor"], {
      parseCliImpl: async () => input,
      resolveRuntimeCliInputImpl: (parsed) => parsed,
      resolveConfiguredCliInputImpl: () => configured,
      loadStartupExtensionsImpl: async () => extensions,
      usesPipedPatchInputImpl: () => false,
      stdinIsTTY: true,
      stdoutIsTTY: false,
    });
    if (plan.kind !== "app") {
      throw new Error("Expected tutor startup to produce an app plan.");
    }

    const setup = await testRender(<AppHost bootstrap={plan.bootstrap} />, {
      width: 80,
      height: 24,
    });
    try {
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("HUNK TUTOR");
      expect(setup.captureCharFrame()).toContain("0/36");
      expect(setup.captureCharFrame()).toContain("Welcome to Hunk Tutor");
      expect(setup.captureCharFrame()).toContain("The diff itself is the guide");
      expect(setup.captureCharFrame()).toContain("read the explanation");
      expect(setup.captureCharFrame()).not.toContain("ext hunk-tutor");

      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("NEXT STEP");
      expect(setup.captureCharFrame()).toContain("open the controls card");
      expect(setup.captureCharFrame()).toContain("ctrl+h");
      expect(setup.captureCharFrame()).not.toContain("visit the next hunk");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("treats lesson view changes as transient when quitting", async () => {
    const input: CliInput = { kind: "tutor", options: { mode: "stack" } };
    const configured: HunkConfigResolution = {
      input: { ...input, options: { ...input.options, promptSaveViewPreferences: true } },
      customThemes: [],
      extensions: { enabled: false, paths: [], repoPaths: [], extensionConfigs: {} },
      keybindings: {},
    };
    const plan = await prepareStartupPlan(["bun", "hunk", "tutor"], {
      parseCliImpl: async () => input,
      resolveRuntimeCliInputImpl: (parsed) => parsed,
      resolveConfiguredCliInputImpl: () => configured,
      loadStartupExtensionsImpl: async () => createEmptyExtensionLoadResult(),
      usesPipedPatchInputImpl: () => false,
      stdinIsTTY: true,
      stdoutIsTTY: false,
    });
    if (plan.kind !== "app") {
      throw new Error("Expected tutor startup to produce an app plan.");
    }

    const quit = mock(() => undefined);
    const setup = await testRender(<AppHost bootstrap={plan.bootstrap} onQuit={quit} />, {
      width: 120,
      height: 28,
    });
    try {
      await flush(setup);
      await act(async () => {
        await setup.mockInput.pressEnter();
        await setup.mockInput.typeText("l");
        await setup.mockInput.typeText("q");
      });
      await flush(setup);

      expect(setup.captureCharFrame()).not.toContain("Save view preferences?");
      expect(quit).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("reveals the panning payoff at the real rightmost viewport", async () => {
    const bootstrap = await loadAppBootstrap({
      kind: "tutor",
      options: { mode: "stack" },
    });
    const scrollingLesson = bootstrap.changeset.files.find(
      (file) => file.path === "02-scrolling-and-panning.md",
    );
    if (!scrollingLesson) {
      throw new Error("Expected the tutor scrolling lesson.");
    }
    bootstrap.changeset = { ...bootstrap.changeset, files: [scrollingLesson] };

    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 80,
      height: 24,
    });
    try {
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("PAN RIGHT");
      expect(setup.captureCharFrame()).not.toContain("YOU FOUND IT");

      for (let index = 0; index < 24; index += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("right", { shift: true });
        });
        await flush(setup);
      }

      expect(setup.captureCharFrame()).toContain("YOU FOUND IT");
      expect(setup.captureCharFrame()).not.toContain("PAN RIGHT");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
