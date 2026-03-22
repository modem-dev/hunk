type Viewer = {
  displayName: string;
  visits: number;
  plan?: "free" | "pro";
};

function welcomeBadge(viewer: Viewer) {
  return viewer.plan === "pro" ? " · Pro" : "";
}

export function renderWelcome(viewer: Viewer) {
  const name = viewer.displayName.trim();

  return `Welcome back, ${name}${welcomeBadge(viewer)}. Session ${viewer.visits}.`;
}

export function renderFooter(viewer: Viewer) {
  return viewer.visits >= 10
    ? "Thanks for sticking with Hunk."
    : "Tip: press ] to jump to the next hunk.";
}
