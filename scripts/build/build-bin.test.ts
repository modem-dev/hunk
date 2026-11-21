import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  bunCompilerCacheEnvironment,
  COMPILE_ENTRYPOINTS,
  compileCommand,
  compileTargetForHost,
  parseBuildOptions,
} from "./build-bin";
import { HUNK_SOURCE_ROOT } from "./package-paths";

describe("COMPILE_ENTRYPOINTS", () => {
  test("starts with the program and names source files that exist", () => {
    expect(COMPILE_ENTRYPOINTS[0]).toBe("main.tsx");

    for (const entrypoint of COMPILE_ENTRYPOINTS) {
      expect(existsSync(path.join(HUNK_SOURCE_ROOT, entrypoint))).toBe(true);
    }
  });
});

describe("compileCommand", () => {
  const base = { bun: "/opt/bun", sourceRoot: "/src", outfile: "/dist/hunk" };

  test("compiles every entrypoint with the host default runtime when there is no target", () => {
    expect(compileCommand({ ...base, target: null })).toEqual([
      "/opt/bun",
      "build",
      "--compile",
      "--no-compile-autoload-bunfig",
      path.join("/src", "main.tsx"),
      path.join("/src", "highlightWorkerEntry.ts"),
      "--outfile",
      "/dist/hunk",
    ]);
  });

  test("passes the compile target ahead of the entrypoints", () => {
    const command = compileCommand({ ...base, target: "bun-linux-x64-baseline" });

    expect(command).toContain("--target=bun-linux-x64-baseline");
    expect(command.indexOf("--target=bun-linux-x64-baseline")).toBeLessThan(
      command.indexOf(path.join("/src", "main.tsx")),
    );
  });

  test("embeds a caller-supplied runtime instead of downloading the target", () => {
    const command = compileCommand({
      ...base,
      target: "bun-linux-x64-baseline",
      runtimeExecutable: "/nix/store/bun-baseline/bin/bun",
    });

    expect(command).toContain("--compile-executable-path=/nix/store/bun-baseline/bin/bun");
  });

  test("omits the runtime flag when none is supplied", () => {
    const command = compileCommand({ ...base, target: "bun-linux-x64-baseline" });

    expect(command.some((arg) => arg.startsWith("--compile-executable-path"))).toBe(false);
  });
});

describe("parseBuildOptions", () => {
  test("reads --runtime-executable in both spellings", () => {
    const runtime = path.resolve("/x/bun");

    expect(parseBuildOptions(["--runtime-executable", runtime]).runtimeExecutable).toBe(runtime);
    expect(parseBuildOptions([`--runtime-executable=${runtime}`]).runtimeExecutable).toBe(runtime);
  });

  test("resolves a relative runtime against the caller's cwd, not the compiler's", () => {
    const callerCwd = path.resolve("/caller");

    expect(
      parseBuildOptions(["--runtime-executable", path.join("bin", "bun")], callerCwd)
        .runtimeExecutable,
    ).toBe(path.join(callerCwd, "bin", "bun"));
  });

  test("defaults to letting Bun resolve the runtime", () => {
    expect(parseBuildOptions([]).runtimeExecutable).toBeNull();
  });

  test("rejects unknown options", () => {
    expect(() => parseBuildOptions(["--outfile", "x"])).toThrow();
  });
});

describe("bunCompilerCacheEnvironment", () => {
  test("keeps downloaded compile targets separate across Bun upgrades", () => {
    const oldRuntime = bunCompilerCacheEnvironment("repo", "1.3.14");
    const newRuntime = bunCompilerCacheEnvironment("repo", "1.4.2");

    expect(newRuntime).toEqual({
      BUN_INSTALL: path.join("repo", ".bun-install", "1.4.2"),
      BUN_INSTALL_CACHE_DIR: path.join("repo", ".bun-install", "1.4.2", "install", "cache"),
    });
    expect(oldRuntime.BUN_INSTALL_CACHE_DIR).not.toBe(newRuntime.BUN_INSTALL_CACHE_DIR);
  });
});

describe("compileTargetForHost", () => {
  test("compiles every x64 platform against Bun's baseline runtime", () => {
    // Bun's default x64 runtime needs AVX2/BMI2; these targets only need x86-64-v2.
    expect(compileTargetForHost("darwin", "x64")).toBe("bun-darwin-x64-baseline");
    expect(compileTargetForHost("win32", "x64")).toBe("bun-windows-x64-baseline");
    expect(compileTargetForHost("linux", "x64", () => false)).toBe("bun-linux-x64-baseline");
  });

  test("keeps the host libc when compiling on a musl x64 host", () => {
    expect(compileTargetForHost("linux", "x64", () => true)).toBe("bun-linux-x64-musl-baseline");
  });

  test("leaves arm64 hosts on Bun's own default runtime", () => {
    expect(compileTargetForHost("darwin", "arm64")).toBeNull();
    expect(compileTargetForHost("linux", "arm64")).toBeNull();
    expect(compileTargetForHost("win32", "arm64")).toBeNull();
  });

  test("returns no target for platforms Hunk does not publish binaries for", () => {
    expect(compileTargetForHost("freebsd", "x64")).toBeNull();
  });
});
