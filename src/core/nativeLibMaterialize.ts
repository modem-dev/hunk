// Stable on-disk home for the OpenTUI native library in compiled binaries.
//
// Bun single-file executables extract an embedded native library to the OS
// temp directory under a fresh random name on every dlopen and never reuse or
// remove it (oven-sh/bun#30962), so repeated invocations leak one library copy
// per launch (#556). The compiled build wires this module in place of each
// OpenTUI platform package's default path export (see
// scripts/opentuiStableNativeLibPlugin.ts): the embedded library bytes are
// written once to a content-addressed path under the user cache directory and
// that stable path is what OpenTUI dlopens. One file per library version,
// reused across runs and processes, in a directory hunk owns.
//
// Any failure falls back to the original embedded path, i.e. the previous
// leaking-but-working behavior, so a read-only cache or exotic mount can never
// break startup. Deletable once Bun's own extraction dedupe
// (oven-sh/bun#29587) ships in a hunk release.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const HASH_HEX_LENGTH = 16;
// Guard against pruning a sibling version that a just-started (older) hunk
// process wrote but has not dlopened yet; that window is milliseconds.
const PRUNE_MIN_AGE_MS = 60 * 60 * 1000;

export interface NativeLibMaterializeDeps {
  cacheRootImpl?: () => string;
  now?: () => number;
  readEmbedded?: (path: string) => Promise<Uint8Array>;
}

/**
 * Conventional per-OS cache root for hunk's native library cache: XDG on
 * Linux, ~/Library/Caches on macOS, %LOCALAPPDATA% on Windows.
 */
export function resolveNativeCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platformImpl: () => NodeJS.Platform = () => platform(),
  homedirImpl: () => string = homedir,
): string {
  const os = platformImpl();
  if (os === "win32") {
    return env.LOCALAPPDATA ?? join(homedirImpl(), "AppData", "Local");
  }
  if (os === "darwin") {
    return join(homedirImpl(), "Library", "Caches");
  }
  return env.XDG_CACHE_HOME ?? join(homedirImpl(), ".cache");
}

/** Split `libopentui.so` into ["libopentui", ".so"] for content-addressed naming. */
function splitLibFileName(libFileName: string): { base: string; ext: string } {
  const dot = libFileName.lastIndexOf(".");
  if (dot <= 0) {
    return { base: libFileName, ext: "" };
  }
  return { base: libFileName.slice(0, dot), ext: libFileName.slice(dot) };
}

/** Best-effort removal of superseded library versions in the cache dir. */
function pruneStaleVersions(
  dir: string,
  base: string,
  ext: string,
  keepName: string,
  nowMs: number,
): void {
  for (const entry of readdirSync(dir)) {
    if (entry === keepName || !entry.startsWith(`${base}-`) || !entry.endsWith(ext)) {
      continue;
    }
    try {
      const fullPath = join(dir, entry);
      if (nowMs - statSync(fullPath).mtimeMs < PRUNE_MIN_AGE_MS) {
        continue;
      }
      // On Windows unlinking a dll a running process still has mapped fails;
      // that and every other error just leaves the file in place.
      unlinkSync(fullPath);
    } catch {
      // Best-effort: leave anything that cannot be removed.
    }
  }
}

/**
 * Copy the embedded native library to its stable content-addressed cache path
 * and return that path, or return `embeddedPath` unchanged on any failure.
 *
 * The write is tmp-file-plus-rename so concurrent first runs of several hunk
 * processes can never observe a truncated library. Once one process has
 * materialized a version, every later process reuses it without a write.
 */
export async function materializeStableNativeLibPath(
  embeddedPath: string,
  libFileName: string,
  deps: NativeLibMaterializeDeps = {},
): Promise<string> {
  const readEmbedded =
    deps.readEmbedded ??
    ((path: string) =>
      Bun.file(path)
        .arrayBuffer()
        .then((buf) => new Uint8Array(buf)));
  const cacheRootImpl = deps.cacheRootImpl ?? (() => resolveNativeCacheRoot());
  const now = deps.now ?? Date.now;

  try {
    const bytes = await readEmbedded(embeddedPath);
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, HASH_HEX_LENGTH);
    const { base, ext } = splitLibFileName(libFileName);
    const dir = join(cacheRootImpl(), "hunk", "native");
    const destName = `${base}-${hash}${ext}`;
    const dest = join(dir, destName);

    if (!existsSync(dest) || statSync(dest).size !== bytes.byteLength) {
      mkdirSync(dir, { recursive: true });
      const tmpPath = join(
        dir,
        `.${base}-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`,
      );
      writeFileSync(tmpPath, bytes, { mode: 0o755 });
      renameSync(tmpPath, dest);
    }

    pruneStaleVersions(dir, base, ext, destName, now());
    return dest;
  } catch {
    // Leaking via Bun's extraction is strictly better than failing to start.
    return embeddedPath;
  }
}
