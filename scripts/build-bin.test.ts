import { describe, expect, test } from "bun:test";
import { compileTargetForHost } from "./build-bin";

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
