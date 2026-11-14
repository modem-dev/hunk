import { describe, expect, test } from "bun:test";
import { APP_COMMAND_CATALOG } from "../../core/run/commandCatalog";
import {
  BROWSER_ALLOWED_HOST_COMMANDS,
  WEB_COMMAND_SUPPORT,
  buildWebCommands,
  isWebImplementedCommand,
  type WebCommandHandlers,
  type WebCommandSupport,
} from "./webCommandTable";

const SUPPORT = WEB_COMMAND_SUPPORT as Record<string, WebCommandSupport>;

/** Handlers that record each command id they run. */
function createTestHandlers() {
  const ran: string[] = [];
  const handlers = new Proxy({} as WebCommandHandlers, {
    get: (_target, id: string) => () => ran.push(id),
  });
  return { handlers, ran };
}

// The browser half of the command-parity hook (audit F1-F3): the page classifies exactly the
// catalog's commands, so a command added to the catalog fails here (and fails to typecheck)
// until the page decides whether it implements, defers, or excludes it.
describe("browser command catalog parity", () => {
  test("classifies exactly the catalogued commands", () => {
    const catalogued = APP_COMMAND_CATALOG.map((entry) => entry.id);
    expect(Object.keys(SUPPORT).sort()).toEqual([...catalogued].sort());
    expect(SUPPORT["hunk.app.openInBrowser"]?.kind).not.toBe("implemented");
  });

  test("gives every command it does not implement a reason", () => {
    for (const [id, support] of Object.entries(SUPPORT)) {
      if (support.kind === "implemented") continue;
      expect({ id, reason: support.reason.length > 10 }).toEqual({ id, reason: true });
    }
  });

  test("implements no host-only command except through an allowlisted route (audit F4)", () => {
    for (const entry of APP_COMMAND_CATALOG) {
      if (entry.locus !== "host-only") continue;
      expect({ id: entry.id, implemented: isWebImplementedCommand(entry.id) }).toEqual({
        id: entry.id,
        implemented: BROWSER_ALLOWED_HOST_COMMANDS.has(entry.id),
      });
    }
    expect([...BROWSER_ALLOWED_HOST_COMMANDS]).toEqual(["hunk.app.refresh"]);
  });

  test("builds the implemented commands in catalog order with the catalog's identity", () => {
    const { handlers } = createTestHandlers();
    const commands = buildWebCommands(handlers);
    expect(commands.map((command) => command.entry.id)).toEqual(
      APP_COMMAND_CATALOG.filter((entry) => isWebImplementedCommand(entry.id)).map(
        (entry) => entry.id,
      ),
    );
    for (const command of commands) {
      expect(command.entry).toBe(
        APP_COMMAND_CATALOG.find((entry) => entry.id === command.entry.id)!,
      );
    }
  });

  test("runs the handler for the command's own id", () => {
    const { handlers, ran } = createTestHandlers();
    const next = buildWebCommands(handlers).find(
      (command) => command.entry.id === "hunk.review.nextHunk",
    )!;
    next.run({ count: 1, shift: false });
    expect(ran).toEqual(["hunk.review.nextHunk"]);
  });

  test("implements every semantic command whose intent the page can apply locally", () => {
    const local = APP_COMMAND_CATALOG.filter(
      (entry) =>
        entry.review?.kind === "expansion/toggle-selected-gap" ||
        (entry.review?.kind === "selection/move" &&
          (entry.review.scope === "hunk" || entry.review.scope === "file")),
    ).map((entry) => entry.id);
    expect(local.every((id) => isWebImplementedCommand(id))).toBe(true);
  });
});
