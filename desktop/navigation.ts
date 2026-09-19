/**
 * Navigation policy for the desktop windows.
 *
 * Deliberately pure: no Electron import, so every rule can be unit tested
 * without booting a window. `main.ts` turns each decision into the matching
 * Electron call (`shell.openExternal`, a preview window, or a deny).
 *
 * Two origins are involved:
 *   - `pi-app://app`     the privileged app shell (preload bridge, /api);
 *   - `pi-preview://export`  a read-only session export preview that gets its
 *     own in-memory partition, no preload and no bridge.
 */

export const APP_SCHEME = "pi-app";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export const PREVIEW_SCHEME = "pi-preview";
export const PREVIEW_HOST = "export";
export const PREVIEW_ORIGIN = `${PREVIEW_SCHEME}://${PREVIEW_HOST}`;
/** In-memory partition (no `persist:` prefix): own storage, cookies and cache. */
export const PREVIEW_PARTITION = "pi-export-preview";

export type NavigationDecision =
  | { action: "allow" }
  | { action: "external"; url: string }
  | { action: "preview"; url: string }
  | { action: "deny"; reason: string };

function parse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Exact scheme + host (port included) comparison. Never a string prefix match,
 * so `pi-app://app.evil.com` and `pi-app://app@evil.com` are both rejected.
 */
export function isSameOrigin(value: string, origin: string): boolean {
  const target = parse(value);
  const base = parse(origin);
  if (!target || !base) return false;
  return target.protocol === base.protocol && target.host === base.host;
}

/** http and https are the only schemes worth handing to the system browser. */
export function isHttpUrl(value: string): boolean {
  const target = parse(value);
  return target !== null && (target.protocol === "http:" || target.protocol === "https:");
}

/** Session ids are opaque tokens; keep them to a conservative, traversal-free set. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXPORT_PATH = /^\/api\/sessions\/([^/]+)\/export$/;
/** Query keys the export document understands (deep links plus inline render). */
const EXPORT_PREVIEW_PARAMS = new Set(["inline", "leafId", "targetId"]);

function exportSessionId(url: URL): string | null {
  const match = EXPORT_PATH.exec(url.pathname);
  if (!match) return null;
  const id = match[1];
  if (!SESSION_ID.test(id) || id.includes("..")) return null;
  return id;
}

/** The exact URL the "view full history" button opens from the app window. */
export function isExportPreviewUrl(value: string, appOrigin = APP_ORIGIN): boolean {
  if (!isSameOrigin(value, appOrigin)) return false;
  const target = parse(value);
  if (!target || !exportSessionId(target)) return false;
  return target.searchParams.get("inline") === "1";
}

/**
 * Map an app-origin export URL onto the dedicated preview origin. Returns null
 * for anything that is not a well-formed inline export preview.
 */
export function previewUrlFor(value: string, appOrigin = APP_ORIGIN): string | null {
  if (!isExportPreviewUrl(value, appOrigin)) return null;
  const target = parse(value)!;
  return `${PREVIEW_ORIGIN}${target.pathname}${target.search}`;
}

/**
 * What the preview protocol is allowed to serve: a read-only GET of one session
 * export document, rendered inline, carrying only the known query keys.
 */
export function isExportPreviewRequestAllowed(method: string, pathWithQuery: string): boolean {
  if (method.toUpperCase() !== "GET") return false;
  const target = parse(`${PREVIEW_ORIGIN}${pathWithQuery}`);
  if (!target || !exportSessionId(target)) return false;

  const params = target.searchParams;
  if (params.get("inline") !== "1" || params.getAll("inline").length !== 1) return false;
  for (const key of params.keys()) {
    if (!EXPORT_PREVIEW_PARAMS.has(key)) return false;
  }
  return true;
}

/**
 * `window.open` / `target=_blank` from the app window. Only the same-origin
 * export preview becomes a window of ours; http(s) goes to the system browser;
 * every other scheme (file:, javascript:, mailto:, ssh:, …) is refused, along
 * with any other same-origin popup that would inherit the app shell.
 */
export function decideWindowOpen(value: string, appOrigin = APP_ORIGIN): NavigationDecision {
  if (isExportPreviewUrl(value, appOrigin)) return { action: "preview", url: value };
  if (isHttpUrl(value)) return { action: "external", url: value };
  return { action: "deny", reason: "blocked popup" };
}

/**
 * Top-level navigation inside the app window. Same-origin pages stay in the
 * window; an inline export is diverted to its own preview; http(s) opens in the
 * system browser; everything else is refused.
 */
export function decideNavigation(value: string, appOrigin = APP_ORIGIN): NavigationDecision {
  if (isExportPreviewUrl(value, appOrigin)) return { action: "preview", url: value };
  if (isSameOrigin(value, appOrigin)) return { action: "allow" };
  if (isHttpUrl(value)) return { action: "external", url: value };
  return { action: "deny", reason: "blocked navigation" };
}

/**
 * The preview window may only ever load its own export documents; a plain
 * http(s) link clicked inside the untrusted page is handed to the system
 * browser instead of replacing the preview.
 */
export function decidePreviewNavigation(value: string): NavigationDecision {
  const target = parse(value);
  if (target && target.protocol === `${PREVIEW_SCHEME}:` && target.host === PREVIEW_HOST) {
    if (isExportPreviewRequestAllowed("GET", `${target.pathname}${target.search}`)) {
      return { action: "allow" };
    }
    return { action: "deny", reason: "preview is read-only" };
  }
  if (isHttpUrl(value)) return { action: "external", url: value };
  return { action: "deny", reason: "preview is read-only" };
}

/**
 * The exported document is self-contained: inline scripts, inline styles and
 * base64 images, but it also embeds session content. This policy keeps it from
 * reaching the network (no tracking pixels, no exfiltration), embedding frames
 * or navigating away, while still allowing the interactions it ships with.
 */
export const EXPORT_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
