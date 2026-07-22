export async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let delayMs = 100;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url);
    } catch (error) {
      if (attempt === attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
  throw new Error("unreachable");
}
