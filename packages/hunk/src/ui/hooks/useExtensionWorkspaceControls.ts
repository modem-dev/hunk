/**
 * Coordinates extension reads and consented workspace writes against the live review.
 * App supplies authority and host callbacks; this hook checks leases, verifies targets, obtains
 * consent, executes writes, and reconciles successful results.
 */
import { writeFile } from "node:fs/promises";
import { useCallback, useMemo, useRef } from "react";
import type { CliInput } from "../../core/run/commandInputs";
import type {
  ExtensionDialogs,
  ExtensionFileSide,
  ExtensionWorkspace,
  ExtensionWorkspaceWriteRequest,
  ExtensionWorkspaceWriteResult,
} from "../../extension-api/types";
import type { ExtensionCapabilityLease } from "../lib/extensionCapabilityLease";
import {
  normalizeWorkspaceWriteRequest,
  resolveExtensionWorkspaceRead,
  resolveExtensionWorkspaceWriteTarget,
  type WorkspaceFileSource,
} from "../lib/extensionWorkspace";
import { verifyWorkspaceWriteTarget } from "../lib/workspaceWriteGuard";

/** Filesystem write implementation used by the host-mediated extension workspace. */
export type WorkspaceFileWriter = (absolutePath: string, text: string) => Promise<void>;

/** Host-owned boundary that tracks irreversible writes through graceful shutdown. */
export type WorkspaceWriteRunner = (write: () => Promise<void>) => Promise<boolean>;

/** The focused controller App uses to attach workspace authority to command contexts. */
export interface ExtensionWorkspaceControlsController {
  /** Build reviewed-document controls attributed to one extension command. */
  createWorkspaceControls(extensionId: string): ExtensionWorkspace;
}

/** Write UTF-8 text through the production filesystem implementation. */
const writeWorkspaceFile: WorkspaceFileWriter = async (absolutePath, text) => {
  await writeFile(absolutePath, text, "utf8");
};

/** Describe an operation retired before its irreversible write boundary. */
function expiredWorkspaceWrite(): ExtensionWorkspaceWriteResult {
  return {
    ok: false,
    reason: "unavailable",
    detail: "The review reloaded before this extension operation could finish.",
  };
}

/** Own live reviewed-document inputs and host-mediated extension workspace operations. */
export function useExtensionWorkspaceControls({
  createExtensionDialogs,
  createReviewCapabilityLease,
  files,
  input,
  onWorkspaceWriteCompleted,
  root,
  runWorkspaceWrite,
  workspaceFileWriter = writeWorkspaceFile,
}: {
  /** Create the attributed FIFO dialog capability shared with extension commands. */
  createExtensionDialogs: (extensionId: string) => Pick<ExtensionDialogs, "confirm">;
  /** Mint authority tied to the current App, registry, and review generation. */
  createReviewCapabilityLease: () => ExtensionCapabilityLease;
  /** Every current reviewed file, including files hidden by filtering. */
  files: readonly WorkspaceFileSource[];
  /** The current CLI review input that decides whether writes are meaningful. */
  input: CliInput;
  /** Reconcile the review currently mounted by the host after a successful write. */
  onWorkspaceWriteCompleted: () => void;
  /** The current repository root, or the review's working directory. */
  root: string;
  /** Start and track one irreversible write, or refuse it during shutdown. */
  runWorkspaceWrite: WorkspaceWriteRunner;
  workspaceFileWriter?: WorkspaceFileWriter;
}): ExtensionWorkspaceControlsController {
  const liveInputsRef = useRef({ files, input, root });
  liveInputsRef.current = { files, input, root };

  const createWorkspaceControls = useCallback(
    (extensionId: string): ExtensionWorkspace => {
      const lease = createReviewCapabilityLease();
      const resolveTarget = (fileId: string) =>
        resolveExtensionWorkspaceWriteTarget({ fileId, ...liveInputsRef.current });

      return {
        async readDocument(fileId: string, side: ExtensionFileSide) {
          // Retained controls become inert before even resolving a request against the review.
          if (!lease.isLive()) return null;
          const read = resolveExtensionWorkspaceRead({
            fileId,
            files: liveInputsRef.current.files,
            side,
          });

          // Missing sides, source errors, and source-size refusals all mean no document.
          const document = read ? await read().catch(() => null) : null;
          return lease.isLive() ? document : null;
        },
        canWriteDocument(fileId: string) {
          // An affordance probe answers false rather than throwing for malformed ids.
          return lease.isLive() && typeof fileId === "string" && resolveTarget(fileId).writable;
        },
        async writeDocument(
          request: ExtensionWorkspaceWriteRequest,
        ): Promise<ExtensionWorkspaceWriteResult> {
          // Malformed requests are extension bugs, including after authority expires.
          const { fileId, text } = normalizeWorkspaceWriteRequest(request);
          if (!lease.isLive()) return expiredWorkspaceWrite();

          const target = resolveTarget(fileId);
          if (!target.writable) {
            return { ok: false, reason: "unavailable", detail: target.detail };
          }

          // Capture one root with the target, then verify links before and after consent.
          const root = liveInputsRef.current.root;
          const verifyTarget = () =>
            verifyWorkspaceWriteTarget({
              absolutePath: target.absolutePath,
              path: target.path,
              root,
            });
          const refusal = await verifyTarget();
          if (!lease.isLive()) return expiredWorkspaceWrite();
          if (refusal) {
            return { ok: false, reason: "unavailable", detail: refusal };
          }

          const confirmed = await createExtensionDialogs(extensionId).confirm({
            title: `Write ${target.path}?`,
            body: `Extension ${extensionId} will replace this file's contents on disk.`,
            confirmLabel: "write",
          });
          if (!lease.isLive()) return expiredWorkspaceWrite();
          if (!confirmed) {
            return {
              ok: false,
              reason: "cancelled",
              detail: `The write to ${target.path} was declined.`,
            };
          }

          const changedTargetRefusal = await verifyTarget();
          if (!lease.isLive()) return expiredWorkspaceWrite();
          if (changedTargetRefusal) {
            return { ok: false, reason: "unavailable", detail: changedTargetRefusal };
          }

          // Authority remains revocable until the host atomically starts the filesystem write.
          if (!lease.isLive()) return expiredWorkspaceWrite();
          try {
            const started = await runWorkspaceWrite(() =>
              workspaceFileWriter(target.absolutePath, text),
            );
            if (!started) return expiredWorkspaceWrite();
          } catch (error) {
            return {
              ok: false,
              reason: "failed",
              detail: `Failed to write ${target.path} • ${
                error instanceof Error ? error.message || error.name : String(error)
              }`,
            };
          }

          // Once started, the real write result wins across reload and reconciles exactly once.
          onWorkspaceWriteCompleted();
          return { ok: true };
        },
      };
    },
    [
      createExtensionDialogs,
      createReviewCapabilityLease,
      onWorkspaceWriteCompleted,
      runWorkspaceWrite,
      workspaceFileWriter,
    ],
  );

  return useMemo(() => ({ createWorkspaceControls }), [createWorkspaceControls]);
}
