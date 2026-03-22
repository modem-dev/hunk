import { expect, test } from "bun:test";
import { renderCommandPreview } from "../src/index";

test("prefers normalized shortcut matches", () => {
  const output = renderCommandPreview("short-cuts");

  expect(output.split("\n")[0]).toBe("• Open help");
  expect(renderCommandPreview("panel")).toContain("Toggle sidebar");
});
