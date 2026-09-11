import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTestSessionWireCorpus,
  serializeTestSessionWireCorpus,
} from "../../../../../test/helpers/session-wire-corpus";
import { HUNK_SESSION_DAEMON_VERSION } from "../protocol";
import { parseSessionRegistration, parseSessionSnapshot } from "./wire";

/**
 * Guards `HUNK_SESSION_DAEMON_VERSION`: the daemon and every window exchange this revision in the
 * signed hello and require an exact match, so any change to what a session puts on the wire must
 * bump it. The fixture filename embeds the revision; a payload change against an existing fixture
 * for the current revision is the failure this test exists to produce.
 */
const FIXTURE_DIR = join(import.meta.dir, "fixtures");
const FIXTURE_NAME = `session-wire.v${HUNK_SESSION_DAEMON_VERSION}.json`;
const FIXTURE_PATH = join(FIXTURE_DIR, FIXTURE_NAME);
const REGENERATE_COMMAND = "bun run generate:session-wire";

describe("session wire snapshot", () => {
  const corpus = buildTestSessionWireCorpus();

  test("every corpus payload round-trips through the daemon parsers", () => {
    for (const entry of corpus) {
      const wireRegistration = JSON.parse(JSON.stringify(entry.registration));
      const wireSnapshot = JSON.parse(JSON.stringify(entry.snapshot));
      expect(parseSessionRegistration(wireRegistration), entry.name).toEqual(wireRegistration);
      expect(parseSessionSnapshot(wireSnapshot), entry.name).toEqual(wireSnapshot);
    }
  });

  test(`the wire corpus matches ${FIXTURE_NAME}`, () => {
    // Compare JSON values rather than text so formatter reflow of the fixture is not a change.
    const rendered = JSON.parse(serializeTestSessionWireCorpus(corpus));
    if (!existsSync(FIXTURE_PATH)) {
      const stale = existsSync(FIXTURE_DIR)
        ? readdirSync(FIXTURE_DIR).filter((name) => /^session-wire\.v\d+\.json$/.test(name))
        : [];
      throw new Error(
        [
          `No wire fixture exists for HUNK_SESSION_DAEMON_VERSION ${HUNK_SESSION_DAEMON_VERSION}.`,
          `Run \`${REGENERATE_COMMAND}\` to write ${FIXTURE_NAME}` +
            (stale.length > 0 ? ` and delete ${stale.join(", ")} in the same change.` : "."),
        ].join(" "),
      );
    }
    const checkedIn = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    if (!Bun.deepEquals(checkedIn, rendered, true)) {
      throw new Error(
        [
          `The session wire payload changed but HUNK_SESSION_DAEMON_VERSION is still ` +
            `${HUNK_SESSION_DAEMON_VERSION}.`,
          "A daemon and a window must speak the same revision, so bump HUNK_SESSION_DAEMON_VERSION " +
            "in packages/hunk/src/session/protocol.ts, then run " +
            `\`${REGENERATE_COMMAND}\` and delete ${FIXTURE_NAME}.`,
          "If the payload change was unintended, revert it instead.",
        ].join("\n"),
      );
    }
    expect(checkedIn).toEqual(rendered);
  });

  test("exactly one wire fixture is checked in, for the current revision", () => {
    const fixtures = readdirSync(FIXTURE_DIR).filter((name) =>
      /^session-wire\.v\d+\.json$/.test(name),
    );
    expect(fixtures).toEqual([FIXTURE_NAME]);
  });
});
