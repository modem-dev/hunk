import type { AgentFileContext } from "../../extension-api/types";
import type { DiffFile } from "../changeset/model";
import type { CommonOptions } from "./commandInputs";

export const EXPERIMENTAL_FEATURES = ["stml"] as const;
export type ExperimentalFeature = (typeof EXPERIMENTAL_FEATURES)[number];

/** Resolve the experimental features enabled for one review launch. */
export function resolveExperimentalFeatures(
  options: Pick<CommonOptions, "experimental">,
): ExperimentalFeature[] {
  return options.experimental ? [...EXPERIMENTAL_FEATURES] : [];
}

/** Return whether one experimental feature is enabled for this review launch. */
export function experimentalFeatureEnabled(
  options: Pick<CommonOptions, "experimental">,
  feature: ExperimentalFeature,
) {
  return options.experimental === true && EXPERIMENTAL_FEATURES.includes(feature);
}

/** Remove disabled STML bodies from one file while preserving plain-text fallbacks. */
function resolveExperimentalAgentFileContext(file: AgentFileContext): AgentFileContext {
  return {
    ...file,
    annotations: file.annotations.map((annotation) => {
      const resolved = { ...annotation };
      delete resolved.markup;
      return resolved;
    }),
  };
}

/** Derive review files whose annotation bodies match the launch's enabled features. */
export function resolveExperimentalDiffFiles(
  files: DiffFile[],
  options: Pick<CommonOptions, "experimental">,
): DiffFile[] {
  if (experimentalFeatureEnabled(options, "stml")) {
    return files;
  }

  return files.map((file) =>
    file.agent ? { ...file, agent: resolveExperimentalAgentFileContext(file.agent) } : file,
  );
}
