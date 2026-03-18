import { describe, expect, mock, test } from "bun:test";
import { shutdownSession } from "../src/core/shutdown";

describe("shutdownSession", () => {
  test("unmounts, destroys, and exits without clearing the restored screen", () => {
    const events: string[] = [];
    const exit = mock((code: number) => {
      events.push(`exit:${code}`);
    });

    shutdownSession({
      root: {
        unmount: () => events.push("unmount"),
      },
      renderer: {
        destroy: () => events.push("destroy"),
      },
      exit,
    });

    expect(events).toEqual(["unmount", "destroy", "exit:0"]);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
