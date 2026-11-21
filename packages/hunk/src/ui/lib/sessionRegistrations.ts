/**
 * Composes bundled UI registrations with the user registry for one review session.
 *
 * Bundled UI (`getBundledUIRegistry()`) and user extensions register through the same public
 * API but live in separate registries with separate lifecycles: the bundled registry is built
 * once per process and never reloads, while the user registry is replaced on extension reload
 * or a trust grant. These helpers merge the two at the point a session consumes them, bundled
 * first, so a bundled command, file view, or highlighter can never be shadowed by a user extension and
 * stays active under `--no-extensions`, where the user load result is simply empty. Panes have
 * the same composition in `extensionPanes.ts`.
 */
import {
  resolveExtensionCommands,
  resolveExtensionFileViews,
  resolveExtensionLineHighlighters,
} from "../../extensions/apply";
import { getBundledUIRegistry } from "../../extensions/default/ui";
import { HUNK_VENDOR_EXTENSION_ID } from "../../extensions/extensionIds";
import type {
  ExtensionRegistry,
  RegisteredCommand,
  RegisteredFileView,
  RegisteredLineHighlighter,
} from "../../extensions/types";

/** Compose bundled commands before user commands, in each registry's registration order. */
export function buildSessionCommands(
  userRegistry: Pick<ExtensionRegistry, "commands"> | undefined,
  bundled: Pick<ExtensionRegistry, "commands"> = getBundledUIRegistry(),
): RegisteredCommand[] {
  return resolveExtensionCommands({
    commands: [...bundled.commands, ...(userRegistry?.commands ?? [])],
  }).commands;
}

/** Compose bundled file views before user file views. */
export function buildSessionFileViews(
  userRegistry: Pick<ExtensionRegistry, "fileViews"> | undefined,
  bundled: Pick<ExtensionRegistry, "fileViews"> = getBundledUIRegistry(),
): RegisteredFileView[] {
  return resolveExtensionFileViews({
    fileViews: [...bundled.fileViews, ...(userRegistry?.fileViews ?? [])],
  }).views;
}

/** Compose bundled line highlighters before user highlighters. */
export function buildSessionLineHighlighters(
  userRegistry: Pick<ExtensionRegistry, "lineHighlighters"> | undefined,
  bundled: Pick<ExtensionRegistry, "lineHighlighters"> = getBundledUIRegistry(),
): RegisteredLineHighlighter[] {
  return resolveExtensionLineHighlighters({
    lineHighlighters: [...bundled.lineHighlighters, ...(userRegistry?.lineHighlighters ?? [])],
  }).highlighters;
}

/**
 * Report whether an extension id names Hunk's own bundled tier, which needs no attribution.
 *
 * The vendor id never appears in the user registry (bundled UI keeps its own registry), so it
 * is recognized structurally; bundled VCS providers do load into the user registry with a
 * `bundled` origin and are recognized there.
 */
export function isBundledExtensionId(
  extensionId: string,
  userRegistry: Pick<ExtensionRegistry, "extensions"> | undefined,
): boolean {
  return (
    extensionId === HUNK_VENDOR_EXTENSION_ID ||
    Boolean(
      userRegistry?.extensions.some(
        (metadata) => metadata.id === extensionId && metadata.origin === "bundled",
      ),
    )
  );
}
