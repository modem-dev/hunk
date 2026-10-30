import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  SESSION_BROKER_SIGNATURE_ALGORITHM,
  type CallerGrant,
  type ProducerGrant,
} from "@hunk/session-broker-core";
import {
  importEd25519PrivateKey,
  importEd25519PublicKey,
  type SessionBrokerCredential,
  type SessionBrokerDaemonIdentity,
} from "@hunk/session-broker";
import { resolveSessionBrokerRuntimePaths } from "./brokerLauncher";
import { HUNK_SESSION_BROKER_APP_ID } from "./appContract";

const CREDENTIAL_VERSION = 1;
const CREDENTIAL_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1_000;
const PRIVATE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

const HUNK_COMMAND_SCOPES = [
  "navigate_to_hunk",
  "reload_session",
  "comment",
  "comment_batch",
  "remove_comment",
  "clear_comments",
  "highlight",
  "clear_highlights",
].map((name) => ({ name, version: 1 })) as readonly { name: string; version: number }[];

interface StoredCredentialFile {
  version: 1;
  role: "daemon" | "producer" | "caller";
  keyId: string;
  publicKey: string;
  privateKey: string;
  grant?: ProducerGrant | CallerGrant;
}

export interface HunkSessionBrokerCredentials {
  readonly daemonIdentity: SessionBrokerDaemonIdentity;
  readonly daemonPublicKey: CryptoKey;
  readonly producer: SessionBrokerCredential<ProducerGrant> & { readonly privateKey: CryptoKey };
  readonly caller: SessionBrokerCredential<CallerGrant> & { readonly privateKey: CryptoKey };
}

export interface HunkCredentialStoreOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly randomBytes?: (length: number) => Uint8Array;
}

function securityError(): never {
  throw new Error(
    "Hunk session credentials are unavailable because their owner-private runtime state is unsafe or malformed.",
  );
}

function encode(bytes: ArrayBuffer | Uint8Array) {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString(
    "base64url",
  );
}

function decode(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) securityError();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== value) securityError();
  return bytes;
}

function randomId(randomBytes: (length: number) => Uint8Array) {
  return `h_${Buffer.from(randomBytes(18)).toString("base64url")}_0`;
}

/** Reject credential directories and files that can redirect reads or expose owner material. */
function validateOwnerPrivatePath(path: string, kind: "directory" | "file") {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    securityError();
  }
  if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())) {
    securityError();
  }
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) securityError();
    const unsafeBits = kind === "directory" ? stat.mode & 0o077 : stat.mode & 0o177;
    if (unsafeBits !== 0) securityError();
  }
}

/** Validate the legacy namespace parent while allowing its historical read/execute mode. */
function ensureRuntimeNamespace(path: string) {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) securityError();
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) securityError();
    if ((stat.mode & 0o022) !== 0) securityError();
  }
}

/** Create and validate the stable hunk-mcp owner-private security directory. */
function ensureSecurityDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  if (process.platform !== "win32") {
    // mkdir honors umask by making permissions narrower, which is safe; never broaden an existing dir.
    validateOwnerPrivatePath(path, "directory");
  } else {
    validateOwnerPrivatePath(path, "directory");
  }
}

/** Read a regular owner-private file through a no-follow descriptor where the runtime supports it. */
function readPrivateFile(path: string): unknown {
  validateOwnerPrivatePath(path, "file");
  let descriptor: number | null = null;
  try {
    const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024) securityError();
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) securityError();
      if ((stat.mode & 0o177) !== 0) securityError();
    }
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } catch {
    securityError();
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function parseStored(value: unknown, role: StoredCredentialFile["role"]): StoredCredentialFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) securityError();
  const record = value as Record<string, unknown>;
  const expected = new Set([
    "version",
    "role",
    "keyId",
    "publicKey",
    "privateKey",
    ...(role === "daemon" ? [] : ["grant"]),
  ]);
  if (
    Object.keys(record).some((key) => !expected.has(key)) ||
    Object.keys(record).length !== expected.size
  )
    securityError();
  if (record.version !== CREDENTIAL_VERSION || record.role !== role) securityError();
  if (typeof record.keyId !== "string" || !/^h_[A-Za-z0-9_-]+_0$/.test(record.keyId))
    securityError();
  decode(record.publicKey);
  decode(record.privateKey);
  if (role !== "daemon") {
    const grant = record.grant as Record<string, unknown> | undefined;
    const grantKeys = new Set([
      "kind",
      "appId",
      "principalId",
      "keyId",
      "grantId",
      "algorithm",
      "issuedAt",
      "expiresAt",
      "revocationId",
      "mayDelegate",
      "operations",
      ...(role === "caller" ? ["commands"] : []),
    ]);
    const expectedOperations =
      role === "producer" ? ["register", "reconnect"] : ["list", "get", "dispatch", "diagnostics"];
    if (
      !grant ||
      Object.keys(grant).length !== grantKeys.size ||
      Object.keys(grant).some((key) => !grantKeys.has(key)) ||
      grant.kind !== role ||
      grant.appId !== HUNK_SESSION_BROKER_APP_ID ||
      grant.principalId !== `hunk-${role}` ||
      grant.keyId !== record.keyId ||
      grant.grantId !== `hunk-${role}-bootstrap-v1` ||
      grant.algorithm !== SESSION_BROKER_SIGNATURE_ALGORITHM ||
      !Number.isFinite(grant.issuedAt) ||
      !Number.isFinite(grant.expiresAt) ||
      (grant.issuedAt as number) >= (grant.expiresAt as number) ||
      grant.revocationId !== `hunk-${role}-bootstrap-v1` ||
      grant.mayDelegate !== false ||
      JSON.stringify(grant.operations) !== JSON.stringify(expectedOperations) ||
      (role === "caller" && JSON.stringify(grant.commands) !== JSON.stringify(HUNK_COMMAND_SCOPES))
    )
      securityError();
  }
  return record as unknown as StoredCredentialFile;
}

/** Atomically adopts a complete credential file without ever replacing a live winner. */
function adoptPrivateFile(
  path: string,
  contents: string,
  randomBytes: (length: number) => Uint8Array,
) {
  const temp = `${path}.tmp-${process.pid}-${Buffer.from(randomBytes(9)).toString("hex")}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      PRIVATE_MODE,
    );
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      // A hard link publishes the already-complete inode and fails rather than replacing a winner.
      requireLink(temp, path);
      if (process.platform !== "win32") {
        const directory = openSync(dirname(path), constants.O_RDONLY);
        try {
          fsyncSync(directory);
        } catch (error) {
          if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            throw error;
          }
        } finally {
          closeSync(directory);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temp, { force: true });
  }
}

function requireLink(source: string, destination: string) {
  linkSync(source, destination);
}

async function createStored(
  role: StoredCredentialFile["role"],
  now: number,
  randomBytes: (length: number) => Uint8Array,
): Promise<StoredCredentialFile> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const keyId = randomId(randomBytes);
  const base = {
    version: CREDENTIAL_VERSION,
    role,
    keyId,
    publicKey: encode(await crypto.subtle.exportKey("spki", pair.publicKey)),
    privateKey: encode(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  } as const;
  if (role === "daemon") return base;
  const common = {
    kind: role,
    appId: HUNK_SESSION_BROKER_APP_ID,
    principalId: `hunk-${role}`,
    keyId,
    grantId: `hunk-${role}-bootstrap-v1`,
    algorithm: SESSION_BROKER_SIGNATURE_ALGORITHM,
    issuedAt: now,
    expiresAt: now + CREDENTIAL_LIFETIME_MS,
    revocationId: `hunk-${role}-bootstrap-v1`,
    mayDelegate: false,
  } as const;
  const grant =
    role === "producer"
      ? ({
          ...common,
          kind: "producer",
          operations: ["register", "reconnect"],
        } satisfies ProducerGrant)
      : ({
          ...common,
          kind: "caller",
          operations: ["list", "get", "dispatch", "diagnostics"],
          commands: HUNK_COMMAND_SCOPES,
        } satisfies CallerGrant);
  return { ...base, grant };
}

async function loadOrCreate(
  path: string,
  role: StoredCredentialFile["role"],
  now: number,
  randomBytes: (length: number) => Uint8Array,
) {
  try {
    return parseStored(readPrivateFile(path), role);
  } catch (error) {
    const code = (() => {
      try {
        lstatSync(path);
        return "exists";
      } catch (cause) {
        return (cause as NodeJS.ErrnoException).code;
      }
    })();
    if (code !== "ENOENT") throw error;
  }
  const generated = await createStored(role, now, randomBytes);
  adoptPrivateFile(path, `${JSON.stringify(generated)}\n`, randomBytes);
  return parseStored(readPrivateFile(path), role);
}

/** Load or safely create Hunk's daemon, producer, and caller Ed25519 bootstrap material. */
export async function loadOrCreateHunkSessionBrokerCredentials(
  options: HunkCredentialStoreOptions = {},
): Promise<HunkSessionBrokerCredentials> {
  const env = options.env ?? process.env;
  const randomBytes =
    options.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
  const runtimeDir = resolveSessionBrokerRuntimePaths(undefined, env).runtimeDir;
  const securityDir = join(runtimeDir, "security-v1");
  ensureRuntimeNamespace(runtimeDir);
  ensureSecurityDirectory(securityDir);
  const now = (options.now ?? Date.now)();
  const [daemon, producer, caller] = await Promise.all([
    loadOrCreate(join(securityDir, "daemon.json"), "daemon", now, randomBytes),
    loadOrCreate(join(securityDir, "producer.json"), "producer", now, randomBytes),
    loadOrCreate(join(securityDir, "caller.json"), "caller", now, randomBytes),
  ]);
  const [
    daemonPublicKey,
    daemonPrivateKey,
    producerPublicKey,
    producerPrivateKey,
    callerPublicKey,
    callerPrivateKey,
  ] = await Promise.all([
    importEd25519PublicKey(decode(daemon.publicKey)),
    importEd25519PrivateKey(decode(daemon.privateKey)),
    importEd25519PublicKey(decode(producer.publicKey)),
    importEd25519PrivateKey(decode(producer.privateKey)),
    importEd25519PublicKey(decode(caller.publicKey)),
    importEd25519PrivateKey(decode(caller.privateKey)),
  ]);
  return Object.freeze({
    daemonIdentity: Object.freeze({ keyId: daemon.keyId, privateKey: daemonPrivateKey }),
    daemonPublicKey,
    producer: Object.freeze({
      grant: producer.grant as ProducerGrant,
      publicKey: producerPublicKey,
      privateKey: producerPrivateKey,
    }),
    caller: Object.freeze({
      grant: caller.grant as CallerGrant,
      publicKey: callerPublicKey,
      privateKey: callerPrivateKey,
    }),
  });
}
