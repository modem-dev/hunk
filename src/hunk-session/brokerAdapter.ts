import {
  buildHunkSessionReview,
  buildListedHunkSession,
  buildSelectedHunkSessionContext,
  listHunkSessionComments,
} from "./projections";
import type {
  HunkSessionCommandResult,
  HunkSessionInfo,
  HunkSessionServerMessage,
  HunkSessionState,
  ListedSession,
  SelectedSessionContext,
  SessionLiveCommentSummary,
  SessionReview,
} from "./types";
import { parseSessionRegistration, parseSessionSnapshot } from "./wire";
import { SessionBrokerState, type SessionBrokerViewAdapter } from "@hunk/session-broker-core";

const hunkSessionBrokerView: SessionBrokerViewAdapter<
  HunkSessionInfo,
  HunkSessionState,
  ListedSession,
  SelectedSessionContext,
  SessionReview,
  SessionLiveCommentSummary
> = {
  parseRegistration: parseSessionRegistration,
  parseSnapshot: parseSessionSnapshot,
  buildListedSession: buildListedHunkSession,
  buildSelectedContext: buildSelectedHunkSessionContext,
  buildSessionReview: buildHunkSessionReview,
  listComments: listHunkSessionComments,
};

export type HunkSessionBrokerState = SessionBrokerState<
  HunkSessionInfo,
  HunkSessionState,
  HunkSessionServerMessage,
  HunkSessionCommandResult,
  ListedSession,
  SelectedSessionContext,
  SessionReview,
  SessionLiveCommentSummary
>;

/** Wire the generic broker core to Hunk's registration, snapshot, and review projections. */
export function createHunkSessionBrokerState(): HunkSessionBrokerState {
  return new SessionBrokerState(hunkSessionBrokerView);
}
