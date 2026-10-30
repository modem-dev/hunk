import {
  BrokerProtocolError,
  SESSION_BROKER_PROTOCOL_REVISION,
  failBrokerProtocol,
  parseBrokerAppPayload,
  parseBrokerIdentifier,
  parseBrokerRevision,
  parseBrokerSelector,
  parseBrokerString,
  parseBrokerTimeout,
  parseExactBrokerRecord,
  type SessionRegistration,
  type SessionServerMessage,
  type SessionSnapshot,
} from "@hunk/session-broker-core";
import type { SessionBrokerDaemonRequest } from "./types";

export type SessionBrokerRuntimeParser<T> = (value: unknown) => T | null;

export interface SessionBrokerCommandParsers<
  CommandName extends string = string,
  Input = unknown,
  Result = unknown,
> {
  readonly command: CommandName;
  readonly version: number;
  readonly parseInput: SessionBrokerRuntimeParser<Input>;
  readonly parseResult: SessionBrokerRuntimeParser<Result>;
}

export interface SessionBrokerAppParserRegistry<
  Info = unknown,
  State = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  Result = unknown,
> {
  readonly brokerRevision?: typeof SESSION_BROKER_PROTOCOL_REVISION;
  readonly appRevision: number;
  readonly features: readonly [];
  readonly parseRegistration: SessionBrokerRuntimeParser<SessionRegistration<Info>>;
  readonly parseSnapshot: SessionBrokerRuntimeParser<SessionSnapshot<State>>;
  readonly commands: readonly SessionBrokerCommandParsers<
    ServerMessage["command"],
    unknown,
    Result
  >[];
}

interface StructuralDispatchRequest<CommandName extends string = string> extends Omit<
  Extract<SessionBrokerDaemonRequest<CommandName>, { action: "dispatch" }>,
  "input"
> {
  input: unknown;
}

export type StructuralSessionBrokerDaemonRequest<CommandName extends string = string> =
  | Exclude<SessionBrokerDaemonRequest<CommandName>, { action: "dispatch" }>
  | StructuralDispatchRequest<CommandName>;

/** A producer envelope whose app-owned payloads remain unknown until controller state parses them. */
export type StructuralSessionClientMessage<Result = unknown> =
  | { type: "register"; registration: unknown; snapshot: unknown }
  | { type: "snapshot"; sessionId: string; snapshot: unknown }
  | { type: "heartbeat"; sessionId: string }
  | { type: "command-result"; requestId: string; ok: true; result: Result }
  | { type: "command-result"; requestId: string; ok: false; error: string };

/** Decode strict UTF-8 JSON without allowing a BOM or surfacing decoder details. */
export function parseSessionBrokerJsonBytes(body: Uint8Array): unknown {
  try {
    if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
      return failBrokerProtocol("invalid-json");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch (error) {
    if (error instanceof BrokerProtocolError) throw error;
    return failBrokerProtocol("invalid-json");
  }
}

/** Parse text JSON at a websocket boundary. */
export function parseSessionBrokerJsonText(message: unknown): unknown {
  if (typeof message !== "string") return failBrokerProtocol("invalid-json");
  try {
    return JSON.parse(message) as unknown;
  } catch {
    return failBrokerProtocol("invalid-json");
  }
}

/** Owns the fixed Phase-1 app contract and every app parser selected by exact command identity. */
export class SessionBrokerProtocolParsers<
  Info = unknown,
  State = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  Result = unknown,
> {
  readonly brokerRevision = SESSION_BROKER_PROTOCOL_REVISION;
  readonly appRevision: number;
  readonly features = Object.freeze([]) as readonly [];
  private readonly parseRegistrationValue: SessionBrokerRuntimeParser<SessionRegistration<Info>>;
  private readonly parseSnapshotValue: SessionBrokerRuntimeParser<SessionSnapshot<State>>;
  private readonly commandParsers = new Map<
    string,
    SessionBrokerCommandParsers<ServerMessage["command"], unknown, Result>
  >();

  constructor(registry: SessionBrokerAppParserRegistry<Info, State, ServerMessage, Result>) {
    if (
      registry.brokerRevision !== undefined &&
      registry.brokerRevision !== SESSION_BROKER_PROTOCOL_REVISION
    ) {
      throw new TypeError("Invalid session broker parser registry.");
    }
    this.appRevision = parseBrokerRevision(registry.appRevision);
    if (!Array.isArray(registry.features) || registry.features.length !== 0) {
      throw new TypeError("Invalid session broker parser registry.");
    }
    if (
      typeof registry.parseRegistration !== "function" ||
      typeof registry.parseSnapshot !== "function" ||
      !Array.isArray(registry.commands)
    ) {
      throw new TypeError("Invalid session broker parser registry.");
    }
    this.parseRegistrationValue = registry.parseRegistration;
    this.parseSnapshotValue = registry.parseSnapshot;
    for (const descriptor of registry.commands) {
      if (
        !descriptor ||
        typeof descriptor !== "object" ||
        typeof descriptor.parseInput !== "function" ||
        typeof descriptor.parseResult !== "function"
      ) {
        throw new TypeError("Invalid session broker parser registry.");
      }
      const command = parseBrokerIdentifier(descriptor.command);
      const version = parseBrokerRevision(descriptor.version);
      const key = this.commandKey(command, version);
      if (this.commandParsers.has(key))
        throw new TypeError("Invalid session broker parser registry.");
      this.commandParsers.set(key, Object.freeze({ ...descriptor, command, version }));
    }
  }

  /** Parse app registration through the one registered callback. */
  parseRegistration(value: unknown): SessionRegistration<Info> {
    return parseBrokerAppPayload(this.parseRegistrationValue, value);
  }

  /** Parse app snapshot through the one registered callback. */
  parseSnapshot(value: unknown): SessionSnapshot<State> {
    return parseBrokerAppPayload(this.parseSnapshotValue, value);
  }

  /** Parse exact command input after the caller has selected a target contract. */
  parseCommandInput<CommandName extends ServerMessage["command"]>(
    command: CommandName,
    version: number,
    value: unknown,
  ): Extract<ServerMessage, { command: CommandName }>["input"] {
    const descriptor = this.lookupCommand(command, version);
    return parseBrokerAppPayload(descriptor.parseInput, value) as Extract<
      ServerMessage,
      { command: CommandName }
    >["input"];
  }

  /** Parse exact command result before pending broker work is resolved. */
  parseCommandResult(command: string, version: number, value: unknown): Result {
    return parseBrokerAppPayload(this.lookupCommand(command, version).parseResult, value);
  }

  /** Parse one producer envelope structurally, leaving app payloads for controller state. */
  parseClientMessage(value: unknown): StructuralSessionClientMessage<Result> {
    const base = parseExactBrokerRecord(
      value,
      ["type"] as const,
      ["registration", "snapshot", "sessionId", "requestId", "ok", "result", "error"] as const,
    );
    if (typeof base.type !== "string") return failBrokerProtocol("invalid-discriminant");
    switch (base.type) {
      case "register": {
        const record = parseExactBrokerRecord(value, ["type", "registration", "snapshot"] as const);
        return {
          type: "register",
          registration: record.registration,
          snapshot: record.snapshot,
        };
      }
      case "snapshot": {
        const record = parseExactBrokerRecord(value, ["type", "sessionId", "snapshot"] as const);
        return {
          type: "snapshot",
          sessionId: parseBrokerIdentifier(record.sessionId),
          snapshot: record.snapshot,
        };
      }
      case "heartbeat": {
        const record = parseExactBrokerRecord(value, ["type", "sessionId"] as const);
        return {
          type: "heartbeat",
          sessionId: parseBrokerIdentifier(record.sessionId),
        };
      }
      case "command-result": {
        const common = parseExactBrokerRecord(
          value,
          ["type", "requestId", "ok"] as const,
          ["result", "error"] as const,
        );
        const requestId = parseBrokerIdentifier(common.requestId);
        if (common.ok === true) {
          const record = parseExactBrokerRecord(value, [
            "type",
            "requestId",
            "ok",
            "result",
          ] as const);
          return {
            type: "command-result",
            requestId,
            ok: true,
            result: record.result as Result,
          };
        }
        if (common.ok === false) {
          const record = parseExactBrokerRecord(value, [
            "type",
            "requestId",
            "ok",
            "error",
          ] as const);
          return {
            type: "command-result",
            requestId,
            ok: false,
            error: parseBrokerString(record.error, { maxBytes: 1_024 }),
          };
        }
        return failBrokerProtocol("invalid-field");
      }
      default:
        return failBrokerProtocol("invalid-discriminant");
    }
  }

  /** Parse one complete daemon-to-producer command envelope before bridge dispatch. */
  parseServerMessage(value: unknown): ServerMessage {
    const record = parseExactBrokerRecord(
      value,
      ["type", "requestId", "command", "input"] as const,
      ["commandVersion"] as const,
    );
    if (record.type !== "command") return failBrokerProtocol("invalid-discriminant");
    const requestId = parseBrokerIdentifier(record.requestId);
    const command = parseBrokerIdentifier(record.command) as ServerMessage["command"];
    const commandVersion =
      record.commandVersion === undefined ? 1 : parseBrokerRevision(record.commandVersion);
    const input = this.parseCommandInput(command, commandVersion, record.input);
    return {
      type: "command",
      requestId,
      command,
      commandVersion,
      input,
    } as ServerMessage;
  }

  /** Parse generic HTTP structure while leaving app input unknown until target selection. */
  parseDaemonRequest(
    value: unknown,
  ): StructuralSessionBrokerDaemonRequest<ServerMessage["command"]> {
    const base = parseExactBrokerRecord(
      value,
      ["action"] as const,
      ["selector", "command", "commandVersion", "input", "timeoutMs", "timeoutMessage"] as const,
    );
    switch (base.action) {
      case "list":
        parseExactBrokerRecord(value, ["action"] as const);
        return { action: "list" };
      case "get": {
        const record = parseExactBrokerRecord(value, ["action", "selector"] as const);
        return {
          action: "get",
          selector: parseBrokerSelector(record.selector),
        };
      }
      case "dispatch": {
        const record = parseExactBrokerRecord(
          value,
          ["action", "selector", "command", "input"] as const,
          ["commandVersion", "timeoutMs", "timeoutMessage"] as const,
        );
        const command = parseBrokerIdentifier(record.command) as ServerMessage["command"];
        const commandVersion =
          record.commandVersion === undefined ? 1 : parseBrokerRevision(record.commandVersion);
        return {
          action: "dispatch",
          selector: parseBrokerSelector(record.selector),
          command,
          commandVersion,
          input: record.input,
          ...(record.timeoutMs === undefined
            ? {}
            : { timeoutMs: parseBrokerTimeout(record.timeoutMs) }),
          ...(record.timeoutMessage === undefined
            ? {}
            : {
                timeoutMessage: parseBrokerString(record.timeoutMessage, {
                  maxBytes: 1_024,
                }),
              }),
        };
      }
      default:
        return failBrokerProtocol("invalid-discriminant");
    }
  }

  private lookupCommand(command: string, version: number) {
    const descriptor = this.commandParsers.get(this.commandKey(command, version));
    if (!descriptor) return failBrokerProtocol("unknown-command");
    return descriptor;
  }

  private commandKey(command: string, version: number) {
    return `${command}\u0000${version}`;
  }
}

/** Snapshot and validate one authoritative fixed-contract parser registry. */
export function createSessionBrokerProtocolParsers<
  Info = unknown,
  State = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  Result = unknown,
>(registry: SessionBrokerAppParserRegistry<Info, State, ServerMessage, Result>) {
  return new SessionBrokerProtocolParsers(registry);
}
