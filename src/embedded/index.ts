import { mountEmbeddedHunkApp as mountEmbeddedHunkAppImpl } from "./mount";
import { createEmbeddedHunkSession as createEmbeddedHunkSessionImpl } from "./session";
import type {
  CreateEmbeddedHunkSessionInput,
  EmbeddedHunkMount,
  EmbeddedHunkSession,
  MountEmbeddedHunkAppInput,
} from "./types";

// Keep the published index.d.ts self-contained; the npm package only copies index/types here.
/** Create one embedded Hunk review session. */
export function createEmbeddedHunkSession(
  input: CreateEmbeddedHunkSessionInput,
): Promise<EmbeddedHunkSession> {
  return createEmbeddedHunkSessionImpl(input);
}

/** Mount an embedded Hunk app into a host-owned OpenTUI container. */
export function mountEmbeddedHunkApp(input: MountEmbeddedHunkAppInput): EmbeddedHunkMount {
  return mountEmbeddedHunkAppImpl(input);
}

export type {
  CreateEmbeddedHunkSessionInput,
  EmbeddedHunkMount,
  EmbeddedHunkOptions,
  EmbeddedHunkSession,
  EmbeddedHunkSnapshot,
  EmbeddedHunkSource,
  MountEmbeddedHunkAppInput,
} from "./types";
