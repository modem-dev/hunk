/**
 * Sample 3 — Dependency injection: `StartupDeps` becomes Layers.
 *
 * Real code: `src/app/startup.ts`.
 *
 * hunk already does dependency injection. It just does it with an options bag
 * of eleven optional `*Impl` overrides, which is the pattern Effect's `Layer`
 * exists to replace. This sample is the clearest "you are already paying for
 * this, Effect just does it properly" case in the codebase.
 */

import { Context, Effect, Layer } from "effect";

// ===========================================================================
// BEFORE — src/app/startup.ts
// ===========================================================================

export interface ParsedCliInput {
  kind: string;
  options: Record<string, unknown>;
}
export interface AppBootstrap {
  changeset: { files: readonly string[] };
}

/**
 * The real thing, abbreviated. Eleven optional fields, every one of them
 * `undefined` in production, every one of them a `?? realImplementation`
 * fallback at the use site.
 */
export interface StartupDeps {
  parseCliImpl?: (argv: string[]) => Promise<ParsedCliInput>;
  readStdinText?: () => Promise<string>;
  looksLikePatchInputImpl?: (text: string) => boolean;
  loadAppBootstrapImpl?: (input: ParsedCliInput) => Promise<AppBootstrap>;
  stdinIsTTY?: boolean;
  // ...six more
}

declare const parseCli: (argv: string[]) => Promise<ParsedCliInput>;
declare const readStdin: () => Promise<string>;
declare const loadAppBootstrap: (input: ParsedCliInput) => Promise<AppBootstrap>;

export async function planStartupBefore(argv: string[], deps: StartupDeps = {}) {
  // Every dependency is re-defaulted here, by hand, on every call.
  const parse = deps.parseCliImpl ?? parseCli;
  const readText = deps.readStdinText ?? readStdin;
  const load = deps.loadAppBootstrapImpl ?? loadAppBootstrap;
  const isTTY = deps.stdinIsTTY ?? process.stdin.isTTY;

  const input = await parse(argv);

  if (!isTTY) {
    const text = await readText();
    if (text.length > 0) {
      return { kind: "static-diff-pager" as const, text };
    }
  }

  return { kind: "app" as const, bootstrap: await load(input) };
}

/**
 * Three problems with this, all of which show up in practice:
 *
 * 1. Nothing propagates. If a helper five levels down needs a new dependency,
 *    `StartupDeps` grows a field and every intermediate function threads it.
 * 2. Nothing is checked. A test that forgets `loadAppBootstrapImpl` silently
 *    hits the real loader and shells out to git. The type system is fine with
 *    that — every field is optional.
 * 3. The defaults are duplicated. `?? parseCli` appears wherever the dep is
 *    used, so "what runs in production" is spread across the file.
 */

// ===========================================================================
// AFTER — the same dependencies as services
// ===========================================================================

/** Each dependency becomes a named service with an interface. */
export class CliParser extends Context.Tag("CliParser")<
  CliParser,
  { readonly parse: (argv: string[]) => Effect.Effect<ParsedCliInput> }
>() {}

export class Stdin extends Context.Tag("Stdin")<
  Stdin,
  { readonly isTTY: Effect.Effect<boolean>; readonly readText: Effect.Effect<string> }
>() {}

export class BootstrapLoader extends Context.Tag("BootstrapLoader")<
  BootstrapLoader,
  { readonly load: (input: ParsedCliInput) => Effect.Effect<AppBootstrap> }
>() {}

export type StartupPlan =
  | { readonly kind: "static-diff-pager"; readonly text: string }
  | { readonly kind: "app"; readonly bootstrap: AppBootstrap };

/**
 * The plan function. No deps parameter at all.
 *
 * The requirements appear in the *third* type slot of the return type:
 * `Effect<StartupPlan, never, CliParser | Stdin | BootstrapLoader>`. That is
 * inferred, not written. It says "this cannot run until someone supplies these
 * three services", and the compiler enforces it at the point where you actually
 * run the program.
 */
export const planStartup = (
  argv: string[],
): Effect.Effect<StartupPlan, never, CliParser | Stdin | BootstrapLoader> =>
  Effect.gen(function* () {
    const parser = yield* CliParser;
    const stdin = yield* Stdin;
    const loader = yield* BootstrapLoader;

    const input = yield* parser.parse(argv);

    if (!(yield* stdin.isTTY)) {
      const text = yield* stdin.readText;
      if (text.length > 0) {
        return { kind: "static-diff-pager" as const, text };
      }
    }

    return { kind: "app" as const, bootstrap: yield* loader.load(input) };
  });

/**
 * Production wiring, declared once, in one place.
 *
 * This is the answer to problem 3: there is exactly one statement of what runs
 * for real, instead of a `??` at every use site.
 */
export const CliParserLive = Layer.succeed(CliParser, {
  parse: (argv) => Effect.promise(() => parseCli(argv)),
});

export const StdinLive = Layer.succeed(Stdin, {
  isTTY: Effect.sync(() => Boolean(process.stdin.isTTY)),
  readText: Effect.promise(() => readStdin()),
});

export const BootstrapLoaderLive = Layer.succeed(BootstrapLoader, {
  load: (input) => Effect.promise(() => loadAppBootstrap(input)),
});

export const StartupLive = Layer.mergeAll(CliParserLive, StdinLive, BootstrapLoaderLive);

/**
 * Test wiring. This is the answer to problem 2.
 *
 * Omit one of these three layers and `Effect.provide` is a *type error* — the
 * requirement channel still has an unsatisfied service in it. A test can no
 * longer accidentally shell out to real git because it forgot a stub.
 */
export const StartupTest = Layer.mergeAll(
  Layer.succeed(CliParser, {
    parse: () => Effect.succeed({ kind: "vcs", options: {} }),
  }),
  Layer.succeed(Stdin, {
    isTTY: Effect.succeed(true),
    readText: Effect.succeed(""),
  }),
  Layer.succeed(BootstrapLoader, {
    load: () => Effect.succeed({ changeset: { files: ["a.ts"] } }),
  }),
);

/** Runnable only once every requirement is discharged. */
export const runStartup = (argv: string[]) =>
  planStartup(argv).pipe(Effect.provide(StartupLive), Effect.runPromise);

// ===========================================================================
// What this does NOT buy you
// ===========================================================================

/**
 * Be honest about the ceiling here. `StartupDeps` is not currently causing
 * bugs. It is 11 fields in one file with one call site, and the tests that use
 * it are readable. Converting it is a real but modest improvement — better
 * test safety and one statement of production wiring — bought with a new
 * concept every contributor has to learn.
 *
 * The reason it appears in this spike is not that it is worth doing on its own.
 * It is that *if* the watch controller and the session daemon move to Effect,
 * they will need services anyway, and at that point `StartupDeps` is the
 * natural boundary to convert next rather than a separate project.
 */
export type SeeMigrationPlan = never;
