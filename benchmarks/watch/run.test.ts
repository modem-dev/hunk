import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { rawResultPath } from "./artifacts";
import { assertCampaignBunVersion, executeWithOneRetry } from "./run";

describe("watch campaign execution policy", () => {
  test("retries exactly once and preserves each failed attempt callback", async () => {
    const attempts: number[] = [];
    const failures: number[] = [];
    const result = await executeWithOneRetry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt === 0) throw new Error("first failed");
        return "recovered";
      },
      (_error, attempt) => {
        failures.push(attempt);
      },
    );
    expect(result).toBe("recovered");
    expect(attempts).toEqual([0, 1]);
    expect(failures).toEqual([0]);
  });

  test("stops after the retry also fails", async () => {
    const attempts: number[] = [];
    await expect(
      executeWithOneRetry(
        async (attempt) => {
          attempts.push(attempt);
          throw new Error(`failure ${attempt}`);
        },
        () => {},
      ),
    ).rejects.toThrow("failure 1");
    expect(attempts).toEqual([0, 1]);
  });

  test("requires the protocol Bun version", () => {
    expect(() => assertCampaignBunVersion("1.3.13")).toThrow("1.3.14");
    expect(() => assertCampaignBunVersion("1.3.14")).not.toThrow();
    expect(() => assertCampaignBunVersion("1.4.0")).toThrow("exact Bun 1.3.14");
  });
});

describe("watch campaign raw naming", () => {
  test("uses stable host/fixture/revision/kind paths and retains retry one", () => {
    expect(
      rawResultPath({
        outputDir: "campaign",
        hostId: "host-linux-x64",
        fixtureId: "little-repo",
        revision: "candidate",
        runKind: "startup",
        runNumber: 3,
      }),
    ).toBe(
      join(
        "campaign",
        "raw",
        "host-linux-x64",
        "little-repo",
        "candidate",
        "startup",
        "run-03.json",
      ),
    );
    expect(
      rawResultPath({
        outputDir: "campaign",
        hostId: "host-linux-x64",
        fixtureId: "little-repo",
        revision: "candidate",
        runKind: "startup",
        runNumber: 3,
        retryAttempt: 1,
      }),
    ).toEndWith(join("candidate", "startup", "run-03-retry-1.json"));
    expect(() =>
      rawResultPath({
        outputDir: "campaign",
        hostId: "../escape",
        fixtureId: "little-repo",
        revision: "base",
        runKind: "idle",
        runNumber: 1,
      }),
    ).toThrow("host ID");
  });
});
