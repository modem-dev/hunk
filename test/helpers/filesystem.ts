import { rm } from "node:fs/promises";

const WINDOWS_RETRYABLE_REMOVE_ERRORS = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

/** Remove a test directory after transient Windows process handles are released. */
export async function removeTestDirectory(path: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
      if (!code || !WINDOWS_RETRYABLE_REMOVE_ERRORS.has(code) || attempt >= 20) {
        throw error;
      }
      await Bun.sleep(100);
    }
  }
}
