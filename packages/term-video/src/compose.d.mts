import type { Shot } from "./plan.mjs";

export const DEFAULT_STAGE_PATH: string;
export const DEFAULT_STAGE_GEOMETRY_PATH: string;

export function findCaptionFont(rootDir: string): string;
export function resolveChromium(explicitPath?: string): string | undefined;
export function buildConcatManifest(
  entries: readonly { file: string; duration: number }[],
  fps: number,
): string;

export function composeStoryboard(options: {
  shots: Shot[];
  workDir: string;
  rootDir: string;
  framesDir?: string;
  stagePath?: string;
  stageGeometryPath?: string;
  fontPath?: string;
  chromiumPath?: string;
  fps?: number;
  captionAnimSeconds?: number;
  viewport?: { width: number; height: number };
  log?: (message: string) => void;
}): Promise<{
  uniqueFrames: number;
  totalSeconds: number;
  concatPath: string;
  outDir: string;
}>;
