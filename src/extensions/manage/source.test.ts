import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseExtensionInstallSource } from "./source";

describe("extension install source parsing", () => {
  test("expands owner/repo shorthand to a GitHub clone URL", () => {
    expect(parseExtensionInstallSource("acme/hunk-word-diff")).toEqual({
      spec: "acme/hunk-word-diff",
      cloneUrl: "https://github.com/acme/hunk-word-diff",
      name: "hunk-word-diff",
    });
  });

  test("splits an @ref suffix off the shorthand", () => {
    expect(parseExtensionInstallSource("acme/hunk-word-diff@v1.2.0")).toEqual({
      spec: "acme/hunk-word-diff@v1.2.0",
      cloneUrl: "https://github.com/acme/hunk-word-diff",
      ref: "v1.2.0",
      name: "hunk-word-diff",
    });
  });

  test("assumes https for a git: prefixed host path", () => {
    expect(parseExtensionInstallSource("git:codeberg.org/acme/hunk-ext@main")).toEqual({
      spec: "git:codeberg.org/acme/hunk-ext@main",
      cloneUrl: "https://codeberg.org/acme/hunk-ext",
      ref: "main",
      name: "hunk-ext",
    });
  });

  test("passes explicit transports through verbatim", () => {
    expect(parseExtensionInstallSource("https://github.com/acme/hunk-ext.git").cloneUrl).toBe(
      "https://github.com/acme/hunk-ext.git",
    );
    expect(parseExtensionInstallSource("git@github.com:acme/hunk-ext.git")).toEqual({
      spec: "git@github.com:acme/hunk-ext.git",
      cloneUrl: "git@github.com:acme/hunk-ext.git",
      name: "hunk-ext",
    });
  });

  test("keeps an scp-like user@host untouched by ref splitting", () => {
    const parsed = parseExtensionInstallSource("git@github.com:acme/hunk-ext@v2");
    expect(parsed.cloneUrl).toBe("git@github.com:acme/hunk-ext");
    expect(parsed.ref).toBe("v2");
  });

  test("accepts a platform-native absolute path source", () => {
    // Built with join so the case exercises real separators on every platform —
    // backslashes on Windows, slashes elsewhere.
    const localPath = join(tmpdir(), "fixtures", "hunk-ext");
    const parsed = parseExtensionInstallSource(localPath);
    expect(parsed.cloneUrl).toBe(resolve(localPath));
    expect(parsed.name).toBe("hunk-ext");
  });

  test("strips a trailing .git from the derived name", () => {
    expect(parseExtensionInstallSource("acme/hunk-ext.git").name).toBe("hunk-ext");
  });

  test("refuses a repository name that cannot be an extension id", () => {
    expect(() => parseExtensionInstallSource("acme/my.weird.repo")).toThrow(
      /cannot be an extension id/,
    );
  });

  test("refuses an empty ref and a bare word", () => {
    expect(() => parseExtensionInstallSource("acme/hunk-ext@")).toThrow(/empty ref/);
    expect(() => parseExtensionInstallSource("not-a-repo")).toThrow(/not a repository/);
  });
});

describe("local path sources", () => {
  test("expands ~ and stores local paths absolute so update survives a cwd change", () => {
    const tilde = parseExtensionInstallSource("~/dev/hunk-word-diff@v1");
    expect(tilde.cloneUrl).toBe(join(homedir(), "dev", "hunk-word-diff"));
    expect(tilde.ref).toBe("v1");

    const relative = parseExtensionInstallSource("./fixtures/hunk-ext");
    expect(isAbsolute(relative.cloneUrl)).toBe(true);
    expect(relative.cloneUrl).toBe(resolve("./fixtures/hunk-ext"));
  });
});
