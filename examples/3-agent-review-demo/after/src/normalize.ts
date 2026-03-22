export function normalizeQuery(value: string) {
  return value.trim().toLowerCase().replace(/[-_]+/g, " ");
}
