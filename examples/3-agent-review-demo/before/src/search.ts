export type Command = {
  id: string;
  label: string;
  keywords?: string[];
};

export function searchCommands(query: string, commands: Command[]) {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return commands;
  }

  return commands.filter((command) => {
    const haystack = [command.label, ...(command.keywords ?? [])].join(" ").toLowerCase();
    return haystack.includes(needle);
  });
}
