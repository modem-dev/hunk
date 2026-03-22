import type { Task } from "./tasks";

export function groupTasks(tasks: Task[]) {
  return {
    shippingToday: tasks.filter((task) => task.state === "done" || task.state === "doing"),
    needsHelp: tasks.filter((task) => task.blocked),
  };
}
