import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { StandaloneFeedbackForm } from "./runFeedbackForm";

describe("standalone feedback form", () => {
  test("prefills `hunk feedback --email` instead of dropping it", async () => {
    const setup = await testRender(
      <StandaloneFeedbackForm initialEmail="ada@example.com" onDone={() => {}} />,
      { width: 100, height: 40 },
    );
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await act(async () => {
          await setup.renderOnce();
          await Bun.sleep(10);
        });
        if (setup.captureCharFrame().includes("ada@example.com")) break;
      }

      const frame = setup.captureCharFrame();
      expect(frame).toContain("ada@example.com");
      expect(frame).toContain("the email you entered, so the team can reply");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
