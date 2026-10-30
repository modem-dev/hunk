import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveCanonicalPath } from "../../core/run/paths";
import { readInstallRecords, resolveInstallRecordsPath } from "./records";

/** Resolve the dependency module root owned by a recorded npm entry, without widening other sources.
 * Registry packages and their hoisted helpers share one isolated node_modules workspace.
 * Only entries inside the recorded package can claim that workspace; neighboring installs,
 * unrecorded folders, and ordinary Git/local extensions retain their existing loader scope.
 */
export function resolveManagedNpmModuleRoot(entryPath: string): string | undefined {
  const path = resolve(entryPath);
  let directory = dirname(path);
  while (true) {
    const parent = dirname(directory);
    if (existsSync(resolveInstallRecordsPath(parent))) {
      // Match the actual directory key through symlinks, Windows casing, and 8.3 names,
      // but return the caller's spelling so the loader can register both path forms.
      const canonicalDirectory = resolveCanonicalPath(directory);
      const name = basename(canonicalDirectory);
      const record = readInstallRecords(parent)[name];
      if (
        record?.kind === "npm" &&
        canonicalDirectory === resolveCanonicalPath(join(parent, name))
      ) {
        const moduleRoot = join(directory, "node_modules");
        const withinPackage = relative(join(moduleRoot, record.packageName), path);
        if (
          withinPackage !== ".." &&
          !withinPackage.startsWith(`..${sep}`) &&
          !isAbsolute(withinPackage)
        ) {
          return moduleRoot;
        }
      }
    }

    if (parent === directory) return undefined;
    directory = parent;
  }
}
