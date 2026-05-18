import type { CliRenderer, Renderable } from "@opentui/core";

export interface EmbeddedHunkOptions {
  mode?: "auto" | "split" | "stack";
  vcs?: "git" | "jj";
  theme?: string;
  watch?: boolean;
  excludeUntracked?: boolean;
  lineNumbers?: boolean;
  wrapLines?: boolean;
  hunkHeaders?: boolean;
  agentNotes?: boolean;
}

export type EmbeddedHunkSource =
  | { kind: "worktree"; pathspecs?: string[]; options?: EmbeddedHunkOptions }
  | { kind: "staged"; pathspecs?: string[]; options?: EmbeddedHunkOptions }
  | {
      kind: "vcs";
      range?: string;
      staged: boolean;
      pathspecs?: string[];
      options?: EmbeddedHunkOptions;
    }
  | { kind: "show"; ref?: string; pathspecs?: string[]; options?: EmbeddedHunkOptions }
  | { kind: "stash-show"; ref?: string; options?: EmbeddedHunkOptions }
  | { kind: "diff"; left: string; right: string; options?: EmbeddedHunkOptions }
  | { kind: "patch"; file?: string; text?: string; label?: string; options?: EmbeddedHunkOptions }
  | { kind: "difftool"; left: string; right: string; path?: string; options?: EmbeddedHunkOptions };

export type EmbeddedHunkSnapshot =
  | { status: "loading"; source: EmbeddedHunkSource }
  | { status: "ready"; source: EmbeddedHunkSource; fileCount: number; title: string }
  | { status: "error"; source: EmbeddedHunkSource; fileCount: number; title: string; error: string };

export interface EmbeddedHunkSession {
  readonly cwd: string;
  readonly source: EmbeddedHunkSource;
  getSnapshot(): EmbeddedHunkSnapshot;
  open(source: EmbeddedHunkSource): Promise<void>;
  reload(): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface EmbeddedHunkMount {
  update(options: { active: boolean; onQuit: () => void }): void;
  unmount(): void;
}

export interface CreateEmbeddedHunkSessionInput {
  cwd?: string;
  source: EmbeddedHunkSource;
}

export interface MountEmbeddedHunkAppInput {
  active: boolean;
  container: Renderable;
  onQuit: () => void;
  renderer: CliRenderer;
  session: EmbeddedHunkSession;
}
