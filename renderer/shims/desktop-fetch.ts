/**
 * Points `window.fetch` at the backend for `/api/…` requests.
 *
 * Everything else (nothing, in practice) still goes to the real fetch, so a
 * mistake here degrades to a normal network error rather than silent breakage.
 */
import { bridgeRequest, isApiUrl, resolveUrl } from "./desktop-http";

export function installDesktopFetch(): void {
  const original = window.fetch.bind(window);

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    const url = resolveUrl(rawUrl);
    if (!url || !isApiUrl(url)) return original(input as RequestInfo, init);

    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      const body = init?.body !== undefined ? init.body : await input.clone().arrayBuffer();
      return bridgeRequest(url, {
        method: init?.method ?? input.method,
        headers,
        body: body as BodyInit,
        signal: init?.signal ?? input.signal,
      });
    }

    return bridgeRequest(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal,
    });
  }) as typeof window.fetch;
}
