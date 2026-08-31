import { HUNK_VENDOR_EXTENSION_ID } from "../../extensionIds";
import { runExtensionFactory } from "../../runExtension";
import {
  createEmptyExtensionRegistry,
  type ExtensionFactory,
  type ExtensionLoadIssue,
  type ExtensionRegistry,
} from "../../types";
import registerBundledEditor, { BUNDLED_EDITOR_COMMAND_FULL_ID } from "./editor";
import registerBundledSidebar from "./sidebar";

let cachedRegistry: ExtensionRegistry | undefined;

/** Register Hunk's default terminal surfaces through one bundled extension identity. */
const registerBundledUI: ExtensionFactory = (hunk) => {
  registerBundledSidebar(hunk);
  registerBundledEditor(hunk);
};

/** Load bundled UI registrations through the public factory path, once per process. */
export function getBundledUIRegistry(): ExtensionRegistry {
  if (cachedRegistry) return cachedRegistry;
  const registry = createEmptyExtensionRegistry();
  const issues: ExtensionLoadIssue[] = [];
  runExtensionFactory({
    metadata: {
      id: HUNK_VENDOR_EXTENSION_ID,
      sourcePath: "hunk:bundled/ui",
      origin: "bundled",
    },
    registry,
    issues,
    factory: registerBundledUI,
  });
  const filesPaneRegistered = registry.panes.some(
    ({ extensionId, pane }) => extensionId === HUNK_VENDOR_EXTENSION_ID && pane.id === "files",
  );
  const editorCommandRegistered = registry.commands.some(
    ({ extensionId, command }) => `${extensionId}.${command.id}` === BUNDLED_EDITOR_COMMAND_FULL_ID,
  );
  if (issues.length > 0 || !filesPaneRegistered || !editorCommandRegistered) {
    throw new Error(
      `Bundled UI failed to register: ${issues[0]?.message ?? "missing required contribution"}`,
    );
  }
  cachedRegistry = registry;
  return registry;
}
