import { constants, type Stats } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { DocumentSource } from "../../core/documents/source";
import {
  DOCUMENT_MAX_BYTES,
  documentBytesIdentity,
  readBoundedDocumentBytes,
  writeDocumentBytes,
} from "./documentBytes";

interface DocumentEditIO {
  safePath: (key: string) => Promise<string>;
  openCheckedPath: (key: string, flags: number) => Promise<FileHandle>;
  read: DocumentSource["read"];
}

/** Read only bounded regular UTF-8 output from an editor-owned copy. */
async function readEditorOutput(copy: string) {
  const edited = await open(
    copy,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!(await edited.stat()).isFile()) throw new Error("Editor output is not a regular file.");
    const bytes = await readBoundedDocumentBytes(edited);
    if (bytes.length > DOCUMENT_MAX_BYTES || bytes.includes(0))
      throw new Error("Editor output exceeds the text viewing policy.");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes;
  } finally {
    await edited.close();
  }
}

/** Refuse writeback when either the selected path's identity or its original bytes changed. */
async function assertOriginalUnchanged(
  key: string,
  opened: Stats,
  identity: string,
  read: DocumentSource["read"],
) {
  const current = await read(key);
  const currentInfo = await lstat(key);
  if (
    current.kind !== "text" ||
    current.identity !== identity ||
    currentInfo.isSymbolicLink() ||
    currentInfo.dev !== opened.dev ||
    currentInfo.ino !== opened.ino
  )
    throw new Error("Document changed while editing; original was not overwritten.");
}

/** Launch an editor on a private copy, then save through the retained checked original handle.
 * Never pass or reopen the collection path for editing. Keep recovery copies after launch errors,
 * invalid editor output, conflicts or write failures; close every handle on all exits.
 */
export async function editDocumentCopy(
  key: string,
  launch: (copy: string) => Promise<string | null>,
  io: DocumentEditIO,
) {
  let temporary: string | undefined;
  let handle: FileHandle | undefined;
  let keepCopy = false;
  try {
    await io.safePath(key);
    const info = await lstat(key);
    if (!info.isFile() || info.isSymbolicLink() || info.size > DOCUMENT_MAX_BYTES)
      return "No editable regular text file selected.";
    handle = await io.openCheckedPath(
      key,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino)
      throw new Error("Document changed during opening.");
    await io.safePath(key);
    const original = await io.read(key);
    if (original.kind !== "text") return original.detail;
    temporary = await mkdtemp(join(tmpdir(), "hunk-edit-"));
    const copy = join(temporary, basename(key));
    const originalBytes = await readBoundedDocumentBytes(handle);
    if (documentBytesIdentity(originalBytes) !== original.identity)
      throw new Error("Document changed while preparing editor copy.");
    await writeFile(copy, originalBytes, { mode: 0o600 });
    keepCopy = true;
    const failure = await launch(copy);
    if (failure) throw new Error(failure);
    const bytes = await readEditorOutput(copy);
    await assertOriginalUnchanged(key, opened, original.identity, io.read);
    if (documentBytesIdentity(bytes) !== original.identity) await writeDocumentBytes(handle, bytes);
    keepCopy = false;
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Cannot edit this entry.";
    return keepCopy ? `${detail} Editor copy retained in ${temporary}.` : detail;
  } finally {
    await handle?.close();
    if (temporary && !keepCopy) await rm(temporary, { recursive: true, force: true });
  }
}
