import { normalizeQuery } from "./normalize";

export type Command = {
  id: string;
  label: string;
  keywords?: string[];
};

export function searchCommands(query: string, commands: Command[]) {
  const needle = normalizeQuery(query);

  if (!needle) {
    return commands;
  }

  return commands
    .map((command) => {
      const label = normalizeQuery(command.label);
      const keywords = (command.keywords ?? []).map(normalizeQuery);

      let score = 0;
      if (label.startsWith(needle)) {
        score += 4;
      }
      if (label.includes(needle)) {
        score += 2;
      }
      if (keywords.some((keyword) => keyword === needle)) {
        score += 3;
      }
      if (keywords.some((keyword) => keyword.includes(needle))) {
        score += 1;
      }

      return { command, score };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.command.label.localeCompare(right.command.label),
    )
    .map((entry) => entry.command);
}
