type WelcomeUser = {
  name: string;
  visits: number;
  plan?: "free" | "pro";
};

export function renderWelcome(user: WelcomeUser) {
  const displayName = user.name.trim();
  const badge = user.plan === "pro" ? " ⭐" : "";

  return `Welcome back, ${displayName}${badge}. You have visited ${user.visits} times.`;
}

export function renderFooter(user: WelcomeUser) {
  return user.visits > 10
    ? "Thanks for sticking with us."
    : "Tell us what you'd like to build next.";
}
