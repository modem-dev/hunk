import { describe, expect, test } from "bun:test";
import type { AppBootstrap } from "../core/types";
import { createSessionRegistration, updateSessionRegistration } from "./sessionRegistration";

function createBootstrap(kittyFollow: boolean): AppBootstrap {
  return {
    input: {
      kind: "vcs",
      staged: false,
      options: { kittyFollow },
    },
    changeset: {
      id: "changeset:test",
      sourceLabel: "/repo",
      title: "repo working tree",
      files: [],
    },
    initialMode: "auto",
  };
}

describe("hunk session registration", () => {
  test("records Kitty follow opt-in on launch", () => {
    const registration = createSessionRegistration(createBootstrap(true));

    expect(registration.info.kittyFollow).toBe(true);
  });

  test("preserves Kitty follow opt-in across reloads", () => {
    const registration = createSessionRegistration(createBootstrap(true));
    const updated = updateSessionRegistration(registration, createBootstrap(false));

    expect(updated.info.kittyFollow).toBe(true);
  });
});
