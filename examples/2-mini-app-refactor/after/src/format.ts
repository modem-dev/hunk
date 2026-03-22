import type { Task } from "./tasks";

function statusChip(task: Task) {
  if (task.blocked) {
    return "[blocked]";
  }

  if (task.state === "done") {
    return "[done]";
  }

  return task.state === "doing" ? "[active]" : "[queued]";
}

export function formatTask(task: Task) {
  return `${statusChip(task)} ${task.title} — ${task.owner}`;
}
