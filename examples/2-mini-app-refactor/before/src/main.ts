import { renderTaskLine } from "./format";
import { tasks } from "./tasks";

export function renderMorningSummary() {
  return ["Morning summary", ...tasks.map(renderTaskLine)].join("\n");
}
