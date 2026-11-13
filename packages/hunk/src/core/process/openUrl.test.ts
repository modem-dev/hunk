import { describe, expect, test } from "bun:test";
import { openUrlInBrowser, planBrowserLaunch, type BrowserLaunch } from "./openUrl";

// Characters a shell or cmd would treat as syntax, plus the fragment that carries the capability.
const URL_WITH_FRAGMENT =
  "http://127.0.0.1:47657/review/session-1/?a=1&b=$(id)#capability=Tok3n_-x";

/** Record launches instead of starting anything. */
function createTestSpawn(result: { ok: boolean; detail?: string } = { ok: true }) {
  const launches: BrowserLaunch[] = [];
  return {
    launches,
    spawn: async (launch: BrowserLaunch) => {
      launches.push(launch);
      return result;
    },
  };
}

describe("planBrowserLaunch", () => {
  test("macOS passes the whole URL to open as one argument", () => {
    expect(planBrowserLaunch(URL_WITH_FRAGMENT, { platform: "darwin", env: {} })).toEqual({
      command: "open",
      args: [URL_WITH_FRAGMENT],
    });
  });

  test("Linux uses xdg-open with the whole URL as one argument", () => {
    expect(
      planBrowserLaunch(URL_WITH_FRAGMENT, { platform: "linux", env: {}, isWsl: false }),
    ).toEqual({ command: "xdg-open", args: [URL_WITH_FRAGMENT] });
  });

  test("$BROWSER wins on Unix: its first entry, with the URL appended", () => {
    expect(
      planBrowserLaunch(URL_WITH_FRAGMENT, {
        platform: "linux",
        env: { BROWSER: "firefox --new-tab:chromium" },
        isWsl: false,
      }),
    ).toEqual({ command: "firefox", args: ["--new-tab", URL_WITH_FRAGMENT] });
    expect(
      planBrowserLaunch(URL_WITH_FRAGMENT, { platform: "freebsd", env: { BROWSER: "w3m" } }),
    ).toEqual({ command: "w3m", args: [URL_WITH_FRAGMENT] });
  });

  test("$BROWSER entries with %s receive the URL in its place, never through a shell", () => {
    expect(
      planBrowserLaunch(URL_WITH_FRAGMENT, {
        platform: "linux",
        env: { BROWSER: "lynx -dump %s" },
        isWsl: false,
      }),
    ).toEqual({ command: "lynx", args: ["-dump", URL_WITH_FRAGMENT] });
  });

  test("an empty $BROWSER falls back to xdg-open", () => {
    expect(
      planBrowserLaunch(URL_WITH_FRAGMENT, {
        platform: "linux",
        env: { BROWSER: " : " },
        isWsl: false,
      }),
    ).toEqual({ command: "xdg-open", args: [URL_WITH_FRAGMENT] });
  });

  test("Windows runs a constant PowerShell script and passes the URL in the environment", () => {
    const launch = planBrowserLaunch(URL_WITH_FRAGMENT, { platform: "win32", env: {} });

    expect(launch).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-Process -FilePath $env:HUNK_OPEN_URL",
      ],
      env: { HUNK_OPEN_URL: URL_WITH_FRAGMENT },
    });
    expect(launch.args.join(" ")).not.toContain("capability");
  });

  test("Windows ignores $BROWSER, which is a Unix convention", () => {
    expect(
      planBrowserLaunch(URL_WITH_FRAGMENT, { platform: "win32", env: { BROWSER: "firefox" } })
        .command,
    ).toBe("powershell.exe");
  });

  test("WSL opens the Windows browser and forwards the URL variable through WSLENV", () => {
    expect(
      planBrowserLaunch(URL_WITH_FRAGMENT, {
        platform: "linux",
        env: { WSLENV: "PATH/l" },
        isWsl: true,
      }),
    ).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-Process -FilePath $env:HUNK_OPEN_URL",
      ],
      env: { HUNK_OPEN_URL: URL_WITH_FRAGMENT, WSLENV: "PATH/l:HUNK_OPEN_URL" },
    });
    expect(
      planBrowserLaunch(URL_WITH_FRAGMENT, { platform: "linux", env: {}, isWsl: true }).env,
    ).toEqual({ HUNK_OPEN_URL: URL_WITH_FRAGMENT, WSLENV: "HUNK_OPEN_URL" });
  });

  test("WSL detection reads the distro variable when not told", () => {
    expect(
      planBrowserLaunch(URL_WITH_FRAGMENT, {
        platform: "linux",
        env: { WSL_DISTRO_NAME: "Ubuntu" },
      }).command,
    ).toBe("powershell.exe");
  });

  test("WSL still honors an explicit $BROWSER", () => {
    expect(
      planBrowserLaunch(URL_WITH_FRAGMENT, {
        platform: "linux",
        env: { BROWSER: "wslview" },
        isWsl: true,
      }),
    ).toEqual({ command: "wslview", args: [URL_WITH_FRAGMENT] });
  });
});

describe("openUrlInBrowser", () => {
  test("hands the planned launch to the spawn and reports success", async () => {
    const spawn = createTestSpawn();

    expect(
      await openUrlInBrowser(URL_WITH_FRAGMENT, { platform: "darwin", spawn: spawn.spawn }),
    ).toEqual({ ok: true });
    expect(spawn.launches).toEqual([{ command: "open", args: [URL_WITH_FRAGMENT] }]);
  });

  test("describes a failure by launcher and status, never by URL", async () => {
    const spawn = createTestSpawn({ ok: false, detail: "ENOENT" });

    const result = await openUrlInBrowser(URL_WITH_FRAGMENT, {
      platform: "linux",
      env: {},
      isWsl: false,
      spawn: spawn.spawn,
    });

    expect(result).toEqual({
      ok: false,
      reason: "Could not open a browser with xdg-open (ENOENT).",
    });
    expect(JSON.stringify(result)).not.toContain("capability");
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
  });

  test("a spawn that throws is a failure, not an exception", async () => {
    const result = await openUrlInBrowser(URL_WITH_FRAGMENT, {
      platform: "darwin",
      spawn: async () => {
        throw new Error(`boom ${URL_WITH_FRAGMENT}`);
      },
    });

    expect(result).toEqual({
      ok: false,
      reason: "Could not open a browser with open (spawn failed).",
    });
  });

  // Starts a real process (never a browser): a missing program must fail without echoing the URL.
  test.skipIf(process.platform === "win32")(
    "a missing $BROWSER program fails with its name only",
    async () => {
      const result = await openUrlInBrowser(URL_WITH_FRAGMENT, {
        platform: "linux",
        env: { BROWSER: "/nonexistent/hunk-test-browser" },
        isWsl: false,
      });

      expect(result).toEqual({
        ok: false,
        reason: "Could not open a browser with /nonexistent/hunk-test-browser (ENOENT).",
      });
    },
  );
});
