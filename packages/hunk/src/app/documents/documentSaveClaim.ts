import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { documentSaveAccountHome } from "./documentSaveAccount";

interface DocumentSaveIdentity {
  dev: number;
  ino: number;
}

interface DocumentSaveClaimOptions {
  directory?: string;
}

/** Locate account/process-namespace coordination independently of session environment overrides. */
async function documentSaveClaimDirectory() {
  const home = await documentSaveAccountHome();

  // A PID is meaningful only in its namespace; shared container homes must not reap host claims.
  const namespace = process.platform === "linux" ? await readlink("/proc/self/ns/pid") : "host";
  const host = createHash("sha256").update(`${hostname()}\0${namespace}`).digest("hex");
  return join(home, ".hunk", "document-save-claims", host);
}

/** Treat unknown process-access failures as live owners; only ESRCH permits stale-claim cleanup. */
function claimOwnerIsAlive(pid: number) {
  if (pid === process.pid) return true;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Require an account-private directory before publishing or trusting save reservations. */
async function prepareClaimDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Cannot secure the document save coordination directory.");

  if (
    typeof process.getuid === "function" &&
    (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700)
  )
    throw new Error("Document save coordination requires an account-private directory.");
}

/** Reserve one inode while saving it for Hunk writers in the same account and process namespace.
 * Each writer publishes a unique claim before scanning for peers. Two contenders can both fail,
 * but cannot both miss each other's still-live claim and enter writeback. Unique names also let
 * readers remove definitely dead owners without accidentally deleting a replacement reservation.
 * Keep inode keys and claim names compatible across releases. This coordinates cooperating Hunk
 * writers in this namespace; it cannot lock out other applications or accounts.
 */
export async function withDocumentSaveClaim<T>(
  identity: DocumentSaveIdentity,
  save: () => Promise<T>,
  { directory: configuredDirectory }: DocumentSaveClaimOptions = {},
): Promise<T> {
  const directory = configuredDirectory ?? (await documentSaveClaimDirectory());
  await prepareClaimDirectory(directory);
  const key = createHash("sha256").update(`${identity.dev}:${identity.ino}`).digest("hex");
  const prefix = `${key}-`;
  const name = `${prefix}${process.pid}-${randomUUID()}.claim`;
  const path = join(directory, name);
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );

  try {
    for (const peer of await readdir(directory, { withFileTypes: true })) {
      if (peer.name === name || !peer.name.startsWith(prefix)) continue;
      const owner = /^([1-9]\d*)-[0-9a-f-]{36}\.claim$/.exec(peer.name.slice(prefix.length));
      const pid = owner ? Number(owner[1]) : NaN;
      if (!peer.isFile() || !Number.isSafeInteger(pid))
        throw new Error("Cannot verify an existing document save reservation.");

      if (claimOwnerIsAlive(pid))
        throw new Error(
          "Another Hunk session is saving this document; original was not overwritten.",
        );
      await rm(join(directory, peer.name), { force: true });
    }
    return await save();
  } finally {
    await handle.close();
    await rm(path, { force: true });
  }
}
