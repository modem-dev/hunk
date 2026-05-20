import { mountEmbeddedHunkApp as mountEmbeddedHunkAppImpl } from "./mount";
import { createEmbeddedHunkSession as createEmbeddedHunkSessionImpl } from "./session";
export type {
  CreateEmbeddedHunkSessionInput,
  EmbeddedHunkMount,
  EmbeddedHunkOptions,
  EmbeddedHunkSession,
  EmbeddedHunkSnapshot,
  EmbeddedHunkSource,
  MountEmbeddedHunkAppInput,
} from "./types";
import type {
  CreateEmbeddedHunkSessionInput,
  EmbeddedHunkMount,
  EmbeddedHunkSession,
  MountEmbeddedHunkAppInput,
} from "./types";

/** Create one embedded Hunk review session from a public embedded source. */
export const createEmbeddedHunkSession = (
  input: CreateEmbeddedHunkSessionInput,
): Promise<EmbeddedHunkSession> => createEmbeddedHunkSessionImpl(input);

/** Mount one embedded Hunk app into a host-owned OpenTUI container. */
export const mountEmbeddedHunkApp = (input: MountEmbeddedHunkAppInput): EmbeddedHunkMount =>
  mountEmbeddedHunkAppImpl(input);
