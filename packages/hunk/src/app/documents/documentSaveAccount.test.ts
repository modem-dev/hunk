import { expect, test } from "bun:test";
import { readDocumentSaveAccountMetadata } from "./documentSaveAccount";

/** Exercise metadata tools that wait for stdin EOF before producing their result. */
test("account metadata closes unused stdin before awaiting the child", async () => {
  const result = await readDocumentSaveAccountMetadata(process.execPath, [
    "-e",
    'await Bun.stdin.text(); console.log("  account-home  ");',
  ]);

  expect(result).toBe("account-home");
});
