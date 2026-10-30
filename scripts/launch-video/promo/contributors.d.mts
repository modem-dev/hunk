// Hand-written declarations for contributors.mjs, which stays plain JS so Node
// can run it without a build step.

export function noreplyLogin(email: string): { login: string; id?: number } | undefined;

export function isExcluded(name: string, email: string): boolean;

export function initialsOf(name: string): string;
