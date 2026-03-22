import { formatTask } from "./format";
import { groupTasks } from "./groupTasks";
import { tasks } from "./tasks";

export function renderMorningSummary() {
  const grouped = groupTasks(tasks);

  return [
    "Morning summary",
    "",
    "Shipping today",
    ...grouped.shippingToday.map(formatTask),
    "",
    "Needs help",
    ...grouped.needsHelp.map(formatTask),
  ].join("\n");
}
