export type Task = {
  id: string;
  title: string;
  owner: string;
  state: "todo" | "doing" | "done";
  blocked?: boolean;
};

export const tasks: Task[] = [
  { id: "T-101", title: "Review onboarding copy", owner: "Maya", state: "done" },
  { id: "T-102", title: "Polish dashboard empty state", owner: "Lee", state: "doing" },
  { id: "T-103", title: "Document keyboard shortcuts", owner: "Sam", state: "todo", blocked: true },
];
