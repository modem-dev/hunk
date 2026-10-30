import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

/** Creates and owns restrictive temporary patches retained for review reloads. */
export class TemporaryPatchStore {
  readonly #temporaryRoot: string;
  readonly #directories = new Set<string>();

  constructor(temporaryRoot: string) {
    this.#temporaryRoot = temporaryRoot;
  }

  /** Writes one patch and retains its directory until removal or cleanup. */
  async write(filename: string, bytes: Uint8Array): Promise<string> {
    const directory = await mkdtemp(join(this.#temporaryRoot, "hunk-github-pr-"));
    this.#directories.add(directory);
    try {
      await chmod(directory, 0o700);
      const patchPath = join(directory, filename.replace(/[^A-Za-z0-9_.-]/g, "-"));
      await writeFile(patchPath, bytes, { flag: "wx", mode: 0o600 });
      return patchPath;
    } catch (error) {
      this.#directories.delete(directory);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** Removes one retained patch directory. */
  async remove(patchPath: string): Promise<void> {
    const directory = dirname(patchPath);
    this.#directories.delete(directory);
    await rm(directory, { recursive: true, force: true });
  }

  /** Removes every retained patch synchronously during extension shutdown. */
  cleanup(): void {
    for (const directory of this.#directories) {
      rmSync(directory, { recursive: true, force: true });
    }
    this.#directories.clear();
  }
}
