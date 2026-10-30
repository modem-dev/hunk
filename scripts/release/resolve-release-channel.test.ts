import { describe, expect, test } from "bun:test";
import { resolveReleaseChannel } from "./resolve-release-channel";

describe("resolveReleaseChannel", () => {
  test("publishes a newer stable release as npm and GitHub latest", () => {
    expect(
      resolveReleaseChannel({
        eventName: "push",
        refName: "v0.19.0",
        currentLatestVersion: "0.18.2",
      }),
    ).toEqual({ npmTag: "latest", makeLatest: true });
  });

  test("keeps an older-series backport away from latest", () => {
    expect(
      resolveReleaseChannel({
        eventName: "push",
        refName: "v0.17.8",
        currentLatestVersion: "0.18.2",
      }),
    ).toEqual({ npmTag: "backport-0.17", makeLatest: false });
  });

  test("publishes prereleases under beta without changing latest", () => {
    for (const refName of ["v0.19.0-alpha.1", "v0.19.0-beta.2", "v0.19.0-rc.1"]) {
      expect(
        resolveReleaseChannel({
          eventName: "push",
          refName,
          currentLatestVersion: "0.18.2",
        }),
      ).toEqual({ npmTag: "beta", makeLatest: false });
    }
  });

  test("honors an explicit manual-dispatch tag", () => {
    expect(
      resolveReleaseChannel({
        eventName: "workflow_dispatch",
        refName: "main",
        requestedNpmTag: "backport-0.17",
      }),
    ).toEqual({ npmTag: "backport-0.17", makeLatest: false });
  });

  test("marks an explicit manual latest dispatch as latest", () => {
    expect(
      resolveReleaseChannel({
        eventName: "workflow_dispatch",
        refName: "main",
        requestedNpmTag: "latest",
      }),
    ).toEqual({ npmTag: "latest", makeLatest: true });
  });

  test("rejects republishing the current latest version", () => {
    expect(() =>
      resolveReleaseChannel({
        eventName: "push",
        refName: "v0.18.2",
        currentLatestVersion: "0.18.2",
      }),
    ).toThrow("already npm latest");
  });

  test("rejects missing manual and stable-version inputs", () => {
    expect(() =>
      resolveReleaseChannel({
        eventName: "workflow_dispatch",
        refName: "main",
      }),
    ).toThrow("requires an npm tag");
    expect(() =>
      resolveReleaseChannel({
        eventName: "push",
        refName: "v0.19",
        currentLatestVersion: "0.18.2",
      }),
    ).toThrow("Expected a stable semantic version");
  });
});
