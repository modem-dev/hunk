// Hand-written declarations for storyboard.mjs, which stays plain JS so Node
// can run it without a build step.

export const promoDir: string;
export const repoRoot: string;
export const storyboardsDir: string;

export function parseArgs(argv: string[]): {
  positional: string[];
  flags: Record<string, string | undefined>;
};

export function compareVersions(a: string, b: string): number;

export function loadStoryboard(path?: string): Promise<{ storyboard: unknown; path: string }>;

export function storyboardProblems(storyboard: unknown): string[];
