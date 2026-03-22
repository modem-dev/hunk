import type { Task } from "./tasks";

export function renderTaskLine(task: Task) {
  const marker = task.state === "done" ? "✓" : task.state === "doing" ? "•" : "○";
  const blocked = task.blocked ? " (blocked)" : "";

  return `${marker} ${task.title} — ${task.owner}${blocked}`;
}
