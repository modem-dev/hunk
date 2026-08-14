import { describe, expect, test } from "bun:test";
import { getTutorDocumentText, TUTOR_PATCH, TUTOR_PATHS } from "./content";

describe("tutor content", () => {
  test("keeps the synthetic review entirely instructional", () => {
    expect(TUTOR_PATHS.every((path) => path.endsWith(".md"))).toBe(true);
    expect(TUTOR_PATCH).toContain("This diff is the tutorial.");
    expect(TUTOR_PATCH).toContain("You are not editing a project.");
    expect(TUTOR_PATCH).toContain("Shortcuts serve one question:");
    expect(TUTOR_PATCH).toContain("It spotlights exact diff text.");
    expect(TUTOR_PATCH).toContain("Drag diff text to copy it.");
    expect(TUTOR_PATCH).not.toContain("starship");
    expect(TUTOR_PATCH).not.toContain("autopilot");
  });

  test("keeps ordinary guide lines readable beside the tutor pane", () => {
    const intentionalOverflow = ["PAN RIGHT", "WRAP THIS LONG EXPLANATION"];
    const ordinaryLines = TUTOR_PATHS.flatMap((path) =>
      (["old", "new"] as const).flatMap((side) =>
        (getTutorDocumentText(path, side) ?? "")
          .split("\n")
          .filter((line) => !intentionalOverflow.some((prefix) => line.startsWith(prefix))),
      ),
    );

    expect(ordinaryLines.every((line) => line.length <= 36)).toBe(true);
  });

  test("puts the panning payoff beyond a normal viewport", () => {
    const revealLine = TUTOR_PATCH.split("\n").find((line) => line.includes("YOU FOUND IT"));

    expect(revealLine).toBeDefined();
    expect(revealLine!.indexOf("YOU FOUND IT")).toBeGreaterThan(120);
    expect(revealLine).toContain("horizontal panning reveals columns");
    expect(revealLine).toEndWith("◆ YOU FOUND IT ◆");
  });

  test("hides an explanation inside unchanged context for the expansion lesson", () => {
    const hiddenSource = getTutorDocumentText("02-scrolling-and-panning.md", "new");

    expect(hiddenSource).toContain("YOU REVEALED THE FOLDED GUIDE");
    expect(TUTOR_PATCH).not.toContain("YOU REVEALED THE FOLDED GUIDE");
    expect(TUTOR_PATCH).toContain("The collapsed section hides a guide");
  });

  test("makes the filter exercise describe the visible result", () => {
    expect(TUTOR_PATHS).toContain("04-find-a-file/needle.md");
    expect(TUTOR_PATCH).toContain("This becomes the only visible file");
    expect(TUTOR_PATCH).toContain("Press Escape to clear the query");
  });
});
