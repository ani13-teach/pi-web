/**
 * Stand-in for `next/server`, aliased in at bundle time (see scripts/build-desktop.mjs).
 * The ported App Router handlers use NextResponse.json, response.cookies and
 * request.cookies, so those three things are implemented here.
 */

type JsonInit = ResponseInit & { status?: number };

type CookieOptions = {
  name: string;
  value: string;
  httpOnly?: boolean;
  sameSite?: "lax" | "strict" | "none";
  secure?: boolean;
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
};

function serializeCookie(options: CookieOptions): string {
  const parts = [`${options.name}=${encodeURIComponent(options.value)}`];
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite[0].toUpperCase()}${options.sameSite.slice(1)}`);
  return parts.join("; ");
}

/** The slice of Next's ResponseCookies the ported code touches. */
class ResponseCookies {
  private readonly headers: Headers;

  constructor(headers: Headers) {
    this.headers = headers;
  }

  set(options: CookieOptions | string, value?: string): void {
    const cookie = typeof options === "string"
      ? serializeCookie({ name: options, value: value ?? "" })
      : serializeCookie(options);
    this.headers.append("set-cookie", cookie);
  }

  delete(name: string, options: Partial<CookieOptions> = {}): void {
    this.set({ ...options, name, value: "", maxAge: 0 });
  }

  get(name: string): { name: string; value: string } | undefined {
    for (const header of this.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const separator = pair.indexOf("=");
      if (pair.slice(0, separator) === name) {
        return { name, value: decodeURIComponent(pair.slice(separator + 1)) };
      }
    }
    return undefined;
  }
}

export class NextResponse extends Response {
  private cookieJar?: ResponseCookies;

  get cookies(): ResponseCookies {
    this.cookieJar ??= new ResponseCookies(this.headers);
    return this.cookieJar;
  }

  static json(data: unknown, init?: JsonInit): NextResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    return new NextResponse(JSON.stringify(data), { ...init, headers });
  }

  static redirect(url: string | URL, init?: number | JsonInit): NextResponse {
    const status = typeof init === "number" ? init : (init?.status ?? 307);
    const headers = new Headers(typeof init === "number" ? undefined : init?.headers);
    headers.set("location", String(url));
    return new NextResponse(null, { status, headers });
  }

  static next(init?: JsonInit): NextResponse {
    return new NextResponse(null, init);
  }
}

/**
 * Route handlers use NextRequest for its `nextUrl` and `cookies`. The router
 * attaches both to the plain Request it passes in, so either spelling works.
 */
export type NextRequest = Request & {
  nextUrl: URL;
  cookies: { get: (name: string) => { name: string; value: string } | undefined };
};

export function attachNextRequestHelpers(request: Request, url: URL): void {
  Object.defineProperty(request, "nextUrl", { value: url, configurable: true });
  Object.defineProperty(request, "cookies", {
    configurable: true,
    value: {
      get: (name: string) => {
        const header = request.headers.get("cookie");
        if (!header) return undefined;
        for (const pair of header.split(";")) {
          const trimmed = pair.trim();
          const separator = trimmed.indexOf("=");
          if (separator === -1) continue;
          if (trimmed.slice(0, separator) === name) {
            return { name, value: decodeURIComponent(trimmed.slice(separator + 1)) };
          }
        }
        return undefined;
      },
    },
  });
}
