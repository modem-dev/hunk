import type { Command } from "./search";

export const commands: Command[] = [
  { id: "open-workspace", label: "Open workspace", keywords: ["project", "folder"] },
  { id: "toggle-sidebar", label: "Toggle sidebar", keywords: ["files", "panel"] },
  { id: "next-hunk", label: "Next hunk", keywords: ["jump", "change"] },
  { id: "open-help", label: "Open help", keywords: ["keyboard", "shortcuts", "short cuts"] },
];
