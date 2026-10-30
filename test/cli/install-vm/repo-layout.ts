import path from "node:path";

/** Resolve a path owned by the publishable Hunk package in the workspace checkout. */
export function resolveHunkPackagePath(repoRoot: string, ...segments: string[]) {
  return path.join(repoRoot, "packages", "hunk", ...segments);
}

/** Resolve the daemon protocol source used to build upgrade fixtures. */
export function resolveHunkProtocolPath(repoRoot: string) {
  return resolveHunkPackagePath(repoRoot, "src", "session", "protocol.ts");
}

/** Resolve the shipped npm wrapper used in synthetic package fixtures. */
export function resolveHunkBinWrapperPath(repoRoot: string) {
  return resolveHunkPackagePath(repoRoot, "bin", "hunk.cjs");
}

/** Resolve one shipped skill directory in the publishable package. */
export function resolveHunkSkillPath(repoRoot: string, skill: string) {
  return resolveHunkPackagePath(repoRoot, "skills", skill);
}
