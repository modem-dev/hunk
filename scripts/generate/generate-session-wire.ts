import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HUNK_SESSION_DAEMON_VERSION } from "../../packages/hunk/src/session/protocol";
import {
  buildTestSessionWireCorpus,
  serializeTestSessionWireCorpus,
} from "../../test/helpers/session-wire-corpus";

/**
 * Regenerate the session wire fixture for the current `HUNK_SESSION_DAEMON_VERSION`. The
 * colocated `wire.snapshot.test.ts` fails when the payload a window registers drifts from the
 * checked-in fixture without a revision bump, so run this only after bumping the revision (or
 * after an intentional no-op refactor that keeps the payload identical). Fixtures for other
 * revisions are removed because exactly one may be checked in.
 */
const fixtureDir = join(import.meta.dir, "../..", "packages/hunk/src/session/broker/fixtures");
const fixtureName = `session-wire.v${HUNK_SESSION_DAEMON_VERSION}.json`;
mkdirSync(fixtureDir, { recursive: true });
for (const name of readdirSync(fixtureDir)) {
  if (/^session-wire\.v\d+\.json$/.test(name) && name !== fixtureName) {
    rmSync(join(fixtureDir, name));
    console.log(`Removed ${join(fixtureDir, name)}`);
  }
}
const fixturePath = join(fixtureDir, fixtureName);
await Bun.write(fixturePath, serializeTestSessionWireCorpus(buildTestSessionWireCorpus()));
console.log(`Wrote ${fixturePath}`);
