import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export type InstallVmProfile = "minimal" | "node";
export type InstallVmNetwork = "local" | "live";

export interface InstallVmScenarioRequiredEvidence {
  commands?: string[];
  commandExpectations?: Record<string, string>;
  assertions?: string[];
  observations?: string[];
}

export interface InstallVmScenario {
  id: string;
  description: string;
  profile: InstallVmProfile;
  script: string;
  network: InstallVmNetwork;
  requiredEvidence?: InstallVmScenarioRequiredEvidence;
}

export interface InstallVmScenarioManifest {
  schemaVersion: 1;
  scenarios: InstallVmScenario[];
}

export interface InstallVmArgs {
  allowSkip: boolean;
  clean: boolean;
  list: boolean;
  reuseFixtures: boolean;
  scenarios: string[];
  cacheDir?: string;
  outputDir?: string;
}

export interface InstallVmAssertion {
  id: string;
  status: "passed" | "failed";
  expected: string;
  actual: string;
  message: string;
}

export interface InstallVmCommandResult {
  id: string;
  status: "passed" | "failed";
  expectation: string;
  exitCode: number;
  logPath: string;
}

export interface InstallVmScenarioObservations {
  hunkVersion?: string;
  installSource?: string;
  resolvedExecutable?: string;
  dependencyTreePath?: string;
  storeProjectionPath?: string;
  [key: string]: string | undefined;
}

export interface InstallVmScenarioResult {
  id: string;
  description: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  exitCode: number;
  commands: InstallVmCommandResult[];
  observations: InstallVmScenarioObservations;
  assertions: InstallVmAssertion[];
  artifacts: string[];
}

export interface InstallVmRunResult {
  schemaVersion: 1;
  run: {
    id: string;
    startedAt: string;
    finishedAt: string;
    platform: "linux-x64";
    sourceIdentity: string;
    status: "passed" | "failed" | "skipped";
    skipReason?: string;
  };
  tools: Record<string, string>;
  scenarios: InstallVmScenarioResult[];
}

export interface InstallVmPins {
  schemaVersion: 1;
  controllerImage: string;
  verdaccioVersion: string;
  pnpmVersion: string;
  historical: {
    hunkdiffVersion: string;
    bunVersion: string;
  };
  firecracker: { version: string; url: string; sha256: string };
  kernel: { version: string; url: string; sha256: string };
  rootfs: { version: string; url: string; sha256: string };
  node: { version: string; url: string; sha256: string };
}

const SCENARIO_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const ZERO_EXIT_COMMAND_EXPECTATIONS = new Set([
  "background PTY remains live",
  "SIGSTOP exact owned B client",
  "SIGCONT exact owned B client",
]);

/** Validate one expectation against the closed install-VM command grammar. */
export function validateInstallVmCommandExpectation(expectation: string, exitCode?: number) {
  const exitMatch = /^exit (-?(?:0|[1-9][0-9]*))$/.exec(expectation);
  if (exitMatch) {
    if (exitCode !== undefined && exitCode !== Number(exitMatch[1])) {
      throw new Error(`Install VM command has impossible exit expectation: ${expectation}.`);
    }
    return;
  }
  if (expectation === "nonzero exit") {
    if (exitCode === 0) {
      throw new Error("Install VM command has impossible nonzero exit expectation.");
    }
    return;
  }
  if (expectation === "observed exit") return;
  if (ZERO_EXIT_COMMAND_EXPECTATIONS.has(expectation)) {
    if (exitCode !== undefined && exitCode !== 0) {
      throw new Error(`Install VM command has impossible zero-exit expectation: ${expectation}.`);
    }
    return;
  }
  throw new Error(`Install VM command has unsupported expectation: ${expectation}.`);
}

/** Validate checksum-attested VM inputs and exact versions used by compatibility scenarios. */
export function validateInstallVmPins(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Pin manifest must be an object.");
  const pins = value as Record<string, unknown>;
  if (pins.schemaVersion !== 1) throw new Error("Pin manifest must use schemaVersion 1.");
  if (
    typeof pins.controllerImage !== "string" ||
    !/@sha256:[a-f0-9]{64}$/.test(pins.controllerImage)
  ) {
    throw new Error("Controller image must use an immutable sha256 digest.");
  }
  for (const name of ["firecracker", "kernel", "rootfs", "node"] as const) {
    const pin = pins[name];
    if (!pin || typeof pin !== "object") throw new Error(`Missing ${name} pin.`);
    const record = pin as Record<string, unknown>;
    if (typeof record.version !== "string" || record.version.length === 0) {
      throw new Error(`${name} pin needs a version label.`);
    }
    if (typeof record.url !== "string" || !record.url.startsWith("https://")) {
      throw new Error(`${name} pin needs an HTTPS URL.`);
    }
    if (typeof record.sha256 !== "string" || !SHA256_PATTERN.test(record.sha256)) {
      throw new Error(`${name} pin needs a lowercase SHA-256 digest.`);
    }
  }
  if (
    typeof pins.verdaccioVersion !== "string" ||
    !EXACT_VERSION_PATTERN.test(pins.verdaccioVersion)
  ) {
    throw new Error("Verdaccio must be pinned to an exact version.");
  }
  if (typeof pins.pnpmVersion !== "string" || !EXACT_VERSION_PATTERN.test(pins.pnpmVersion)) {
    throw new Error("pnpm must be pinned to an exact version.");
  }
  if (!pins.historical || typeof pins.historical !== "object") {
    throw new Error("Historical package pins are required.");
  }
  const historical = pins.historical as Record<string, unknown>;
  for (const [name, version] of [
    ["hunkdiff", historical.hunkdiffVersion],
    ["bun", historical.bunVersion],
  ] as const) {
    if (typeof version !== "string" || !EXACT_VERSION_PATTERN.test(version)) {
      throw new Error(`Historical ${name} must be pinned to an exact version.`);
    }
  }
  return pins as unknown as InstallVmPins;
}

/** Parse the explicit install-VM runner command line without consulting the host. */
export function parseInstallVmArgs(argv: string[]): InstallVmArgs {
  const options: InstallVmArgs = {
    allowSkip: false,
    clean: false,
    list: false,
    reuseFixtures: false,
    scenarios: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-skip") {
      options.allowSkip = true;
    } else if (argument === "--clean") {
      options.clean = true;
    } else if (argument === "--list") {
      options.list = true;
    } else if (argument === "--reuse-fixtures") {
      options.reuseFixtures = true;
    } else if (argument === "--scenario" || argument === "--cache-dir" || argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      index += 1;
      if (argument === "--scenario") options.scenarios.push(value);
      if (argument === "--cache-dir") options.cacheDir = value;
      if (argument === "--output") options.outputDir = value;
    } else {
      throw new Error(`Unknown install VM option: ${argument}`);
    }
  }

  if (new Set(options.scenarios).size !== options.scenarios.length) {
    throw new Error("Each --scenario id may be selected only once.");
  }
  if (options.clean && (options.list || options.scenarios.length > 0 || options.outputDir)) {
    throw new Error("--clean cannot be combined with listing, selection, or output options.");
  }

  return options;
}

/** Validate and return a JSON scenario manifest. */
export function validateScenarioManifest(value: unknown): InstallVmScenarioManifest {
  if (!value || typeof value !== "object") throw new Error("Scenario manifest must be an object.");
  const manifest = value as Partial<InstallVmScenarioManifest>;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.scenarios)) {
    throw new Error("Scenario manifest must use schemaVersion 1 and contain scenarios.");
  }

  const ids = new Set<string>();
  for (const scenario of manifest.scenarios) {
    if (!scenario || typeof scenario !== "object")
      throw new Error("Every scenario must be an object.");
    if (!SCENARIO_ID_PATTERN.test(scenario.id))
      throw new Error(`Invalid scenario id: ${scenario.id}`);
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    if (!scenario.description.trim())
      throw new Error(`Scenario ${scenario.id} needs a description.`);
    if (scenario.profile !== "minimal" && scenario.profile !== "node") {
      throw new Error(`Scenario ${scenario.id} has an unsupported profile.`);
    }
    if (scenario.network !== "local" && scenario.network !== "live") {
      throw new Error(`Scenario ${scenario.id} has an unsupported network policy.`);
    }
    if (path.basename(scenario.script) !== scenario.script || !scenario.script.endsWith(".sh")) {
      throw new Error(`Scenario ${scenario.id} has an unsafe script path.`);
    }
    if (scenario.requiredEvidence !== undefined) {
      if (!scenario.requiredEvidence || typeof scenario.requiredEvidence !== "object") {
        throw new Error(`Scenario ${scenario.id} has malformed required evidence.`);
      }
      const requiredEvidence = scenario.requiredEvidence as Record<string, unknown>;
      const expectedKeys = ["commands", "commandExpectations", "assertions", "observations"];
      if (Object.keys(requiredEvidence).some((key) => !expectedKeys.includes(key))) {
        throw new Error(`Scenario ${scenario.id} has unknown required evidence.`);
      }
      for (const key of ["commands", "assertions", "observations"] as const) {
        const entries = requiredEvidence[key];
        if (entries === undefined) continue;
        if (
          !Array.isArray(entries) ||
          entries.length === 0 ||
          entries.some(
            (entry) =>
              typeof entry !== "string" ||
              (key === "observations"
                ? !/^[A-Za-z][A-Za-z0-9]*$/.test(entry)
                : !SCENARIO_ID_PATTERN.test(entry)),
          ) ||
          new Set(entries).size !== entries.length
        ) {
          throw new Error(`Scenario ${scenario.id} has malformed required ${key}.`);
        }
      }
      const commandExpectations = requiredEvidence.commandExpectations;
      if (commandExpectations !== undefined) {
        if (
          !commandExpectations ||
          typeof commandExpectations !== "object" ||
          Array.isArray(commandExpectations) ||
          (Object.getPrototypeOf(commandExpectations) !== Object.prototype &&
            Object.getPrototypeOf(commandExpectations) !== null)
        ) {
          throw new Error(`Scenario ${scenario.id} has malformed command expectations.`);
        }
        const commands = requiredEvidence.commands;
        const expectationRecord = commandExpectations as Record<string, unknown>;
        if (
          !Array.isArray(commands) ||
          Object.keys(expectationRecord).sort().join("\0") !== [...commands].sort().join("\0")
        ) {
          throw new Error(
            `Scenario ${scenario.id} command expectations must exactly match required commands.`,
          );
        }
        for (const [commandId, expectation] of Object.entries(expectationRecord)) {
          if (!SCENARIO_ID_PATTERN.test(commandId) || typeof expectation !== "string") {
            throw new Error(`Scenario ${scenario.id} has malformed command expectations.`);
          }
          validateInstallVmCommandExpectation(expectation);
        }
      }
    }
  }

  return manifest as InstallVmScenarioManifest;
}

/** Load the committed scenario manifest. */
export function loadScenarioManifest(manifestPath: string) {
  return validateScenarioManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
}

/** Resolve selected scenario ids or reject unknown ids before starting Docker. */
export function selectScenarios(
  manifest: InstallVmScenarioManifest,
  selectedIds: readonly string[],
) {
  if (selectedIds.length === 0) return [...manifest.scenarios];
  const byId = new Map(manifest.scenarios.map((scenario) => [scenario.id, scenario]));
  return selectedIds.map((id) => {
    const scenario = byId.get(id);
    if (!scenario) throw new Error(`Unknown install VM scenario: ${id}`);
    return scenario;
  });
}

/** Decide whether an expected command outcome passed, including negative commands. */
export function evaluateCommandExpectation(
  exitCode: number,
  allowedExitCodes: readonly number[],
  output: string,
  requiredMarkers: readonly string[] = [],
) {
  if (allowedExitCodes.length === 0) throw new Error("Expected exit-code set cannot be empty.");
  const failures: string[] = [];
  if (!allowedExitCodes.includes(exitCode)) {
    failures.push(`expected exit ${allowedExitCodes.join(" or ")}, got ${exitCode}`);
  }
  for (const marker of requiredMarkers) {
    if (!output.includes(marker)) failures.push(`missing marker: ${marker}`);
  }
  return { passed: failures.length === 0, failures };
}

/** Escape one value for XML text and attributes. */
export function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Project one structured install run into deterministic JUnit XML. */
export function buildInstallVmJunit(result: InstallVmRunResult) {
  const scenarios = [...result.scenarios].sort((left, right) => left.id.localeCompare(right.id));
  const failures = scenarios.filter((scenario) => scenario.status === "failed").length;
  const skipped = scenarios.filter((scenario) => scenario.status === "skipped").length;
  const time = scenarios.reduce((total, scenario) => total + scenario.durationMs, 0) / 1000;
  const cases = scenarios
    .map((scenario) => {
      const attributes = `classname="install-vm" name="${escapeXml(scenario.id)}" time="${(
        scenario.durationMs / 1000
      ).toFixed(3)}"`;
      if (scenario.status === "skipped") {
        return `  <testcase ${attributes}><skipped message="scenario skipped"/></testcase>`;
      }
      if (scenario.status === "failed") {
        const messages = scenario.assertions
          .filter((assertion) => assertion.status === "failed")
          .map((assertion) => `${assertion.id}: ${assertion.message}`)
          .join("\n");
        return `  <testcase ${attributes}><failure message="install scenario failed">${escapeXml(messages || `exit ${scenario.exitCode}`)}</failure></testcase>`;
      }
      return `  <testcase ${attributes}/>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="install-vm" tests="${scenarios.length}" failures="${failures}" skipped="${skipped}" time="${time.toFixed(3)}">\n${cases}\n</testsuite>\n`;
}

/** Resolve one runtime path without following a symlink outside the harness-owned tmp tree. */
export function assertSafeInstallVmRuntimePath(
  repoRoot: string,
  target: string,
  options: { allowRoot?: boolean } = {},
) {
  if (/[,\0-\x1f\x7f]/.test(target)) {
    throw new Error(
      `Install VM runtime paths cannot contain commas or control characters: ${target}`,
    );
  }

  const physicalRepoRoot = realpathSync(repoRoot);
  const allowedRoot = path.join(physicalRepoRoot, "tmp", "install-vm");
  const resolved = path.resolve(target);
  const relative = path.relative(allowedRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing install VM path outside ${allowedRoot}: ${resolved}`);
  }
  if (!options.allowRoot && relative === "") {
    throw new Error(`Install VM runtime path must be below ${allowedRoot}.`);
  }

  let cursor = physicalRepoRoot;
  for (const segment of path.relative(physicalRepoRoot, resolved).split(path.sep)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`Refusing install VM path with symlink ancestor: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return resolved;
}

/** Ensure a destructive clean target stays inside this repository's harness-owned tmp root. */
export function assertSafeCleanTarget(repoRoot: string, target: string) {
  const resolved = assertSafeInstallVmRuntimePath(repoRoot, target, { allowRoot: true });
  if (resolved === path.parse(resolved).root) {
    throw new Error(`Refusing unsafe install VM clean target: ${resolved}`);
  }
  return resolved;
}

/** Reject bind roots that overlap and could let one cleanup remove another resource. */
export function assertDistinctInstallVmRuntimePaths(paths: Record<string, string>) {
  const entries = Object.entries(paths);
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const left = entries[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const right = entries[rightIndex]!;
      const relative = path.relative(left[1], right[1]);
      const reverse = path.relative(right[1], left[1]);
      const leftContainsRight =
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
      const rightContainsLeft =
        reverse === "" ||
        (!reverse.startsWith(`..${path.sep}`) && reverse !== ".." && !path.isAbsolute(reverse));
      if (leftContainsRight || rightContainsLeft) {
        throw new Error(`Install VM runtime paths overlap: ${left[0]} and ${right[0]}.`);
      }
    }
  }
}

export interface DockerRunPaths {
  cacheDir: string;
  fixtureDir: string;
  outputDir: string;
}

/** Build the controller image from the same validated image and Node pins used by the guest. */
export function buildControllerImageCommand(
  image: string,
  harnessRoot: string,
  pins: InstallVmPins,
) {
  return [
    "docker",
    "build",
    "--build-arg",
    `CONTROLLER_IMAGE=${pins.controllerImage}`,
    "--build-arg",
    `NODE_VERSION=${pins.node.version}`,
    "--build-arg",
    `NODE_URL=${pins.node.url}`,
    "--build-arg",
    `NODE_SHA256=${pins.node.sha256}`,
    "--tag",
    image,
    harnessRoot,
  ];
}

/** Build the least-privilege Docker command used only by the explicit VM runner. */
export function buildDockerRunCommand(
  image: string,
  paths: DockerRunPaths,
  scenarioIds: readonly string[],
  hostIdentity: { uid: number; gid: number },
) {
  for (const mountPath of Object.values(paths)) {
    if (/[,\0-\x1f\x7f]/.test(mountPath)) {
      throw new Error(`Unsafe Docker bind path for install VM: ${mountPath}`);
    }
  }
  if (scenarioIds.some((id) => !SCENARIO_ID_PATTERN.test(id))) {
    throw new Error("Unsafe install VM scenario id in Docker command.");
  }
  return [
    "docker",
    "run",
    "--rm",
    "--cap-drop=ALL",
    "--cap-add=NET_ADMIN",
    "--cap-add=CHOWN",
    "--cap-add=DAC_OVERRIDE",
    "--device=/dev/kvm",
    "--device=/dev/net/tun",
    "--security-opt=no-new-privileges",
    "--sysctl=net.ipv4.ip_forward=1",
    "--read-only",
    "--tmpfs=/tmp:rw,nosuid,nodev,mode=1777",
    "--tmpfs=/run:rw,nosuid,nodev,mode=755",
    `--env=INSTALL_VM_SCENARIOS=${scenarioIds.join(",")}`,
    `--env=HOST_UID=${hostIdentity.uid}`,
    `--env=HOST_GID=${hostIdentity.gid}`,
    `--mount=type=bind,src=${paths.cacheDir},dst=/cache`,
    `--mount=type=bind,src=${paths.fixtureDir},dst=/fixtures,readonly`,
    `--mount=type=bind,src=${paths.outputDir},dst=/artifacts`,
    image,
  ];
}
