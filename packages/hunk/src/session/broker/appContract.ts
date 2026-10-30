import {
  SESSION_BROKER_PROTOCOL_REVISION,
  type BrokerAppContract,
} from "@hunk/session-broker-core";
import { HUNK_SESSION_DAEMON_VERSION } from "../protocol";

/** Defines Hunk's immutable Phase-1 broker and application wire contract. */
export const HUNK_SESSION_BROKER_APP_ID = "dev.hunk" as const;
export const HUNK_SESSION_BROKER_REVISION = SESSION_BROKER_PROTOCOL_REVISION;
export const HUNK_SESSION_BROKER_APP_REVISION = HUNK_SESSION_DAEMON_VERSION;
export const HUNK_SESSION_BROKER_FEATURES = Object.freeze([]) as readonly [];
export const HUNK_SESSION_BROKER_APP_CONTRACT: Readonly<BrokerAppContract> = Object.freeze({
  appRevision: HUNK_SESSION_BROKER_APP_REVISION,
  features: HUNK_SESSION_BROKER_FEATURES,
});
