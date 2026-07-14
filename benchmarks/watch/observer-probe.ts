#!/usr/bin/env bun

import { fileURLToPath } from "node:url";
import { computeWatchSignature } from "../../src/core/watch";
import { createWatchController } from "../../src/core/watchController";
import { createWatchObserver, type WatchObserver } from "../../src/core/watchObserver";
import { resolveWatchPlan, type WatchPlan } from "../../src/core/watchPlan";
import type { ObserverBackend } from "./schema";

export interface ObserverProbeChildResult {
  status: "ready" | "timeout" | "error";
  planDerivationMs: number;
  constructionToReadyMs: number | null;
  selectedBackend: ObserverBackend;
  degraded: boolean;
  errors: string[];
}

/** Describe the tree backend selected by production observer dispatch for this host. */
export function selectedObserverBackend(plan: WatchPlan): ObserverBackend {
  if (plan.coverage === "poll-only") return "poll-only";
  const hasTreeTarget = plan.targets.some((target) => target.kind === "directory-tree");
  if (!hasTreeTarget) return "chokidar-portable";
  return process.platform === "darwin" || process.platform === "win32"
    ? "native-recursive"
    : "chokidar-portable";
}

/** Exercise the production plan, observer, and controller seams without starting the TUI. */
export async function executeObserverProbe(
  repoDir: string,
  timeoutMs = 30_000,
  onResult?: (result: ObserverProbeChildResult) => void,
): Promise<ObserverProbeChildResult> {
  const input = {
    kind: "vcs" as const,
    staged: false,
    options: { vcs: "git", watch: true },
  };
  const errors: string[] = [];
  const planStartedAt = performance.now();
  const plan = resolveWatchPlan(input, { cwd: repoDir });
  const planDerivationMs = performance.now() - planStartedAt;
  if (!plan) throw new Error("Candidate watch plan was not available");

  const initialSignature = computeWatchSignature(input, { cwd: repoDir });
  let observer: WatchObserver | undefined;
  let sourceReady = false;
  const constructionStartedAt = performance.now();
  const controller = createWatchController({
    initialSignature,
    getSignature: () => computeWatchSignature(input, { cwd: repoDir }),
    refresh: () => {},
    startupTimeoutMs: timeoutMs,
    reportError(error) {
      errors.push(error instanceof Error ? error.message : String(error));
    },
    createEventSource(callbacks) {
      observer = createWatchObserver(plan, {
        ...callbacks,
        onReady() {
          sourceReady = true;
          callbacks.onReady?.();
        },
      });
      return observer;
    },
  });

  try {
    if (!observer) throw new Error("Observer was not constructed");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      observer.ready.then(() => false),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    const state = controller.getState();
    const result: ObserverProbeChildResult = {
      status: timedOut || !sourceReady ? "timeout" : errors.length ? "error" : "ready",
      planDerivationMs,
      constructionToReadyMs: sourceReady ? performance.now() - constructionStartedAt : null,
      selectedBackend: selectedObserverBackend(plan),
      degraded: state.degraded,
      errors,
    };
    onResult?.(result);
    return result;
  } finally {
    controller.close();
    if (observer) {
      let closeTimeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        observer.closed,
        new Promise<void>((resolve) => {
          closeTimeout = setTimeout(resolve, 2_000);
        }),
      ]).finally(() => {
        if (closeTimeout) clearTimeout(closeTimeout);
      });
    }
  }
}

/** Launch the headless probe as a separate process and measure process-launch-to-ready output. */
export async function launchObserverProbe(options: {
  repoDir: string;
  timeoutMs?: number;
}): Promise<ObserverProbeChildResult & { processLaunchToReadyMs: number }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const scriptPath = fileURLToPath(import.meta.url);
  const launchedAt = performance.now();
  const child = Bun.spawn(
    [process.execPath, scriptPath, "--repo", options.repoDir, "--timeout-ms", String(timeoutMs)],
    { stdout: "pipe", stderr: "pipe", env: process.env },
  );
  const stderrPromise = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  let readyAt = performance.now();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    stdout += decoder.decode(chunk.value, { stream: true });
    if (stdout.includes("\n")) {
      readyAt = performance.now();
      break;
    }
  }
  reader.releaseLock();
  const exitCode = await child.exited;
  const stderr = await stderrPromise;
  if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || "Observer probe failed");
  const result = JSON.parse(stdout.trim()) as ObserverProbeChildResult;
  return { ...result, processLaunchToReadyMs: readyAt - launchedAt };
}

/** Read one required option from the probe's minimal private CLI. */
function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main(args: string[]): Promise<void> {
  let emitted = false;
  const result = await executeObserverProbe(
    option(args, "--repo"),
    Number(option(args, "--timeout-ms")),
    (readyResult) => {
      emitted = true;
      process.stdout.write(`${JSON.stringify(readyResult)}\n`);
    },
  );
  if (!emitted) process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
