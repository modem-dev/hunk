import { describe, expect, test } from "bun:test";
import {
  collectIdleSamples,
  createProcessSampler,
  parsePsCpuTime,
  type ProcessSampler,
  type SamplerSystem,
} from "./sampler";

describe("watch process samplers", () => {
  test("parses cumulative ps CPU formats", () => {
    expect(parsePsCpuTime("01:02")).toBe(62_000);
    expect(parsePsCpuTime("01:02:03.5")).toBe(3_723_500);
    expect(parsePsCpuTime("2-01:00:00")).toBe(176_400_000);
    expect(() => parsePsCpuTime("bad")).toThrow();
  });

  test("reads Linux CPU ticks and RSS through an injected system", () => {
    const fields = ["S", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "20", "10", "0"];
    const system: SamplerSystem = {
      platform: "linux",
      fileExists: () => true,
      readFile(path) {
        return path.endsWith("/stat")
          ? `123 (hunk worker) ${fields.join(" ")}`
          : "VmRSS:\t4096 kB\n";
      },
      run: () => "100\n",
      isAlive: () => true,
    };
    expect(createProcessSampler(system).sample(123)).toEqual({
      cpuTimeMs: 300,
      rssBytes: 4_194_304,
      alive: true,
    });
  });

  test("samples absolute deadlines with a fake clock and preserves errors", async () => {
    let now = 0;
    let calls = 0;
    const sampler: ProcessSampler = {
      sample() {
        calls += 1;
        if (calls === 2) throw new Error("sample unavailable");
        return { cpuTimeMs: calls * 10, rssBytes: calls * 100, alive: true };
      },
    };
    const samples = await collectIdleSamples({
      pid: 1,
      durationMs: 20_000,
      intervalMs: 10_000,
      sampler,
      clock: {
        now: () => now,
        async sleep(ms) {
          now += ms;
        },
      },
    });
    expect(samples.map((sample) => sample.elapsedMs)).toEqual([0, 10_000, 20_000]);
    expect(samples[1]).toMatchObject({
      cpuTimeMs: null,
      rssBytes: null,
      error: "sample unavailable",
    });
    expect(now).toBe(20_000);
  });
});
