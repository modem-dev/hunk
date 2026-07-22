export async function fetchOnce(url: string): Promise<Response> {
  return fetch(url);
}
