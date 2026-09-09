import { SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE } from "@hunk/session-broker";

/** Show only the fixed lifecycle-defect message in Hunk's user-visible error console. */
export function reportHunkSessionBrokerLifecycleDefect(_message: string) {
  console.error(SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE);
}
