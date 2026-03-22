import { expect, test } from "bun:test";
import { renderCommandPreview } from "../src/index";

test("filters commands by substring", () => {
  expect(renderCommandPreview("help")).toContain("Open help");
  expect(renderCommandPreview("panel")).toContain("Toggle sidebar");
});
