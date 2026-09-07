/** Find the sidebar divider where it crosses the top frame, excluding the outer pane borders. */
export function getTestSidebarDividerColumn(frame: string) {
  const topBorder = frame.split("\n").find((line) => line.includes("┌") && line.includes("│"));
  return topBorder?.indexOf("│") ?? -1;
}

/** Extract only sidebar columns so review headers cannot satisfy sidebar assertions. */
export function getTestSidebarFrame(frame: string) {
  const divider = getTestSidebarDividerColumn(frame);
  return divider < 0
    ? ""
    : frame
        .split("\n")
        .map((line) => line.slice(0, divider))
        .join("\n");
}
