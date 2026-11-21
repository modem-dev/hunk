// Hand-written declarations for timeline.mjs, which stays plain JS so Node
// can run it without a build step.

export function frameTimes(duration: number, fps: number): number[];

export function encodeArgs(options: {
  framesPattern: string;
  fps: number;
  output: string;
}): string[];

export function renderTimeline(options: {
  pagePath: string;
  workDir: string;
  output?: string;
  stills?: number[];
  stillsDir?: string;
  fps?: number;
  viewport?: { width: number; height: number };
  chromiumPath?: string;
  log?: (message: string) => void;
}): Promise<{ duration: number; frames?: number; output?: string; stillsDir?: string }>;
