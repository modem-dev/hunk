import { describe, expect, mock, test } from "bun:test";
import { shutdownSession } from "./shutdown";

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

  test("attempts every owner and preserves the first cleanup failure", () => {
    const events: string[] = [];
    const unmountError = new Error("unmount failed");
    expect(() =>
      shutdownSession({
        root: {
          unmount: () => {
            events.push("unmount");
            throw unmountError;
          },
        },
        renderer: {
          destroy: () => {
            events.push("destroy");
            throw new Error("destroy failed");
          },
        },
        exit: () => {
          events.push("exit");
          throw new Error("exit failed");
        },
      }),
    ).toThrow(unmountError);
    expect(events).toEqual(["unmount", "destroy", "exit"]);
  });
});
