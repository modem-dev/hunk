/**
 * Builds the `statusLine` and `prompts` capabilities one extension receives, scoped to that
 * extension and to the authority of the context that handed them out.
 *
 * Item ids are namespaced `ext:<extensionId>:<id>` so two extensions can never collide with
 * each other or with host items, and so a registry replacement can clear every extension item
 * in one sweep. Malformed input is a programming error and throws, like malformed dialog
 * options; a prompt validation failure rejects the returned promise for the same reason.
 */
import type {
  ExtensionPromptControls,
  ExtensionPromptLineOptions,
  ExtensionStatusItem,
  ExtensionStatusLineControls,
} from "../../extension-api/types";
import { extensionToastPrefix } from "../lib/extensionNotifications";
import type { StatusLineStore } from "./store";
import type { StatusSpan } from "./types";

const EXTENSION_ITEM_PREFIX = "ext:";
const TONES = new Set(["muted", "accent", "accent-muted", "syntax", "added", "removed"]);
const ATTRIBUTES = new Set(["bold", "italic", "underline", "strikethrough"]);

/** Report whether a store item id belongs to an extension rather than the host. */
export function isExtensionStatusItemId(id: string) {
  return id.startsWith(EXTENSION_ITEM_PREFIX);
}

function invalid(method: string, problem: string): never {
  throw new Error(`${method} ${problem}`);
}

function normalizeItemId(method: string, id: unknown) {
  if (typeof id !== "string" || id.trim().length === 0) {
    invalid(method, "requires a non-empty id.");
  }
  return id;
}

/** Copy and validate one span so a later mutation by the extension cannot change the row. */
function normalizeSpan(span: unknown): StatusSpan {
  if (span === null || typeof span !== "object") {
    invalid("statusLine.set", "spans must be objects with string text.");
  }
  const { text, tone, attributes } = span as Record<string, unknown>;
  if (typeof text !== "string") {
    invalid("statusLine.set", "spans must be objects with string text.");
  }
  if (tone !== undefined && (typeof tone !== "string" || !TONES.has(tone))) {
    invalid("statusLine.set", `span tone "${String(tone)}" is not a known tone.`);
  }
  if (attributes !== undefined) {
    if (!Array.isArray(attributes) || attributes.some((entry) => !ATTRIBUTES.has(entry))) {
      invalid("statusLine.set", "span attributes must list known emphasis names.");
    }
  }
  return {
    text,
    ...(tone === undefined ? {} : { tone: tone as StatusSpan["tone"] }),
    ...(attributes === undefined
      ? {}
      : { attributes: [...(attributes as NonNullable<StatusSpan["attributes"]>)] }),
  };
}

function normalizeItem(extensionId: string, item: unknown): ExtensionStatusItem {
  if (item === null || typeof item !== "object") {
    invalid("statusLine.set", "requires an item object.");
  }
  const { id, spans, alignment, priority } = item as Record<string, unknown>;
  const itemId = normalizeItemId("statusLine.set", id);
  if (!Array.isArray(spans)) {
    invalid("statusLine.set", "requires spans to be an array.");
  }
  if (alignment !== undefined && alignment !== "left" && alignment !== "right") {
    invalid("statusLine.set", 'alignment must be "left" or "right".');
  }
  if (priority !== undefined && (typeof priority !== "number" || !Number.isFinite(priority))) {
    invalid("statusLine.set", "priority must be a finite number.");
  }
  return {
    id: `${EXTENSION_ITEM_PREFIX}${extensionId}:${itemId}`,
    spans: spans.map(normalizeSpan),
    ...(alignment === undefined ? {} : { alignment }),
    ...(priority === undefined ? {} : { priority }),
  };
}

/** Build the `statusLine` controls one extension's contexts receive. */
export function createExtensionStatusLineControls(
  store: StatusLineStore,
  extensionId: string,
  isLive: () => boolean = () => true,
): ExtensionStatusLineControls {
  return Object.freeze({
    set(item: ExtensionStatusItem) {
      const normalized = normalizeItem(extensionId, item);
      if (!isLive()) return;
      store.setItem(normalized);
    },
    clear(id: string) {
      const itemId = normalizeItemId("statusLine.clear", id);
      if (!isLive()) return;
      store.clearItem(`${EXTENSION_ITEM_PREFIX}${extensionId}:${itemId}`);
    },
  });
}

function normalizePromptOptions(options: unknown): ExtensionPromptLineOptions {
  if (options === null || typeof options !== "object") {
    invalid("prompts.line", "requires an options object.");
  }
  const { prefix, placeholder, initial, onChange } = options as Record<string, unknown>;
  for (const [name, value] of [
    ["prefix", prefix],
    ["placeholder", placeholder],
    ["initial", initial],
  ] as const) {
    if (value !== undefined && typeof value !== "string") {
      invalid("prompts.line", `${name} must be a string when given.`);
    }
  }
  if (onChange !== undefined && typeof onChange !== "function") {
    invalid("prompts.line", "onChange must be a function when given.");
  }
  return {
    prefix: prefix as string | undefined,
    placeholder: placeholder as string | undefined,
    initial: initial as string | undefined,
    onChange: onChange as ExtensionPromptLineOptions["onChange"],
  };
}

/** Build the `prompts` controls one extension's command context receives. */
export function createExtensionPromptControls(
  store: StatusLineStore,
  extensionId: string,
  options: {
    isLive?: () => boolean;
    /** Whether the prompt names its third-party owner; bundled extensions omit the marker. */
    showAttribution: boolean;
    warn?: (message: string) => void;
  },
): ExtensionPromptControls {
  return Object.freeze({
    // Async so a validation failure rejects the returned promise instead of throwing
    // synchronously out of the extension's `await`.
    async line(lineOptions: ExtensionPromptLineOptions) {
      const normalized = normalizePromptOptions(lineOptions);
      return await store.requestPrompt(normalized, {
        isLive: options.isLive,
        attribution: options.showAttribution ? `${extensionToastPrefix()} ${extensionId}` : null,
        onChangeFailed: (detail) =>
          options.warn?.(`Extension ${extensionId} prompt onChange failed • ${detail}`),
      });
    },
  });
}
