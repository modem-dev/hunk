import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Read bounded OS account metadata without loading shell profiles or repository configuration. */
export async function readDocumentSaveAccountMetadata(command: string, args: string[]) {
  const pending = execute(command, args, {
    encoding: "utf8",
    maxBuffer: 8192,
    // Cold PowerShell/.NET startup can exceed five seconds on shared Windows runners.
    timeout: process.platform === "win32" ? 15_000 : 5000,
    windowsHide: true,
  });
  // These lookups never consume input. Close the pipe so noninteractive account tools cannot
  // wait for stdin EOF until the lookup deadline expires.
  pending.child.stdin?.end();
  const { stdout } = await pending;
  return stdout.trim();
}

/** Resolve the account home from OS records, never session HOME/USERPROFILE overrides.
 * Bun's userInfo/homedir projections honor environment overrides and cannot identify a namespace
 * shared by differently configured windows. Missing account metadata fails closed before saving.
 */
export async function documentSaveAccountHome() {
  let home: string | undefined;
  if (process.platform === "win32") {
    const powershell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    home = await readDocumentSaveAccountMetadata(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)",
    ]);
  } else {
    const uid = process.getuid?.();
    if (uid === undefined)
      throw new Error("Cannot identify the OS account for document save coordination.");
    if (process.platform === "darwin") {
      const record = await readDocumentSaveAccountMetadata("/usr/bin/dscacheutil", [
        "-q",
        "user",
        "-a",
        "uid",
        String(uid),
      ]);
      home = /^dir:\s*(.+)$/m.exec(record)?.[1]?.trim();
    } else {
      const local = await readFile("/etc/passwd", "utf8").catch(() => "");
      home = local
        .split("\n")
        .map((line) => line.split(":"))
        .find((fields) => fields[2] === String(uid))?.[5];
      if (!home) {
        const record = await readDocumentSaveAccountMetadata("/usr/bin/getent", [
          "passwd",
          String(uid),
        ]);
        const fields = record.split(":");
        if (fields[2] === String(uid)) home = fields[5];
      }
    }
  }

  if (!home || !isAbsolute(home))
    throw new Error("Cannot locate the OS account home for document save coordination.");
  return home;
}
