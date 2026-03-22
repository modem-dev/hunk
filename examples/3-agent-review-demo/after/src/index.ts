import { commands } from "./commands";
import { searchCommands } from "./search";

export function renderCommandPreview(query: string) {
  return searchCommands(query, commands)
    .slice(0, 3)
    .map((command) => `• ${command.label}`)
    .join("\n");
}
