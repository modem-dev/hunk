import type { AgentContext, AgentFileContext, CommonOptions, DiffFile } from "./types";

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

/** Remove disabled STML bodies while preserving their required plain-text fallbacks. */
export function resolveExperimentalAgentContext(
  context: AgentContext | null,
  options: Pick<CommonOptions, "experimental">,
): AgentContext | null {
  if (!context || experimentalFeatureEnabled(options, "stml")) {
    return context;
  }

  return {
    ...context,
    files: context.files.map(resolveExperimentalAgentFileContext),
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
