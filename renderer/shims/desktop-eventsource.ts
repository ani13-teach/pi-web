/**
 * EventSource on top of IPC.
 *
 * pi-web's live views (agent events, terminal output, file watching, login
 * flows) all use EventSource. This implementation speaks the same wire format
 * — `data:` frames, optional `event:` names, comment heartbeats — so those
 * components stay untouched.
 *
 * Those components let the browser reconnect for them, so a dropped stream
 * (EOF, a transport error, a 5xx response) is retried after the server's
 * `retry:` time, `Last-Event-ID` included so the server can resume where it
 * stopped. Only a final answer — 204, a 4xx, or a body that is not an event
 * stream — leaves the object CLOSED, and `close()` never fires another event.
 */
import { bridgeRequest } from "./desktop-http";

type EventSourceInitLike = { withCredentials?: boolean };

/** Reconnection time used until a frame carries a `retry:` field. */
const DEFAULT_RETRY_MS = 1000;

class DesktopEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;

  readonly url: string;
  readonly withCredentials: boolean = false;
  readyState = DesktopEventSource.CONNECTING;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private lastEventId = "";
  private retryMs = DEFAULT_RETRY_MS;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private abort = new AbortController();

  constructor(url: string, init?: EventSourceInitLike) {
    super();
    this.url = url;
    this.withCredentials = Boolean(init?.withCredentials);
    void this.connect();
  }

  close(): void {
    this.closed = true;
    this.readyState = DesktopEventSource.CLOSED;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abort.abort();
    this.releaseReader();
  }

  /** Stops pulling from the backend once this side is done with the stream. */
  private releaseReader(): void {
    const reader = this.reader;
    this.reader = null;
    if (reader) void reader.cancel().catch(() => {}).finally(() => reader.releaseLock());
  }

  /** One attempt: it either streams until EOF or ends in `failed()`. */
  private async connect(): Promise<void> {
    try {
      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (this.lastEventId) headers["last-event-id"] = this.lastEventId;

      const response = await bridgeRequest(this.url, {
        method: "GET",
        headers,
        signal: this.abort.signal,
      });

      if (this.closed) {
        await response.body?.cancel();
        return;
      }
      const contentType = response.headers.get("content-type") ?? "";
      // Asking again would only produce the same 204/4xx, and a body that is
      // not an event stream is not something a retry can turn into one.
      if (
        response.status === 204
        || (response.status >= 400 && response.status < 500)
        || (response.ok && !contentType.includes("text/event-stream"))
      ) {
        await response.body?.cancel();
        this.failed(true);
        return;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`EventSource ${this.url} failed with ${response.status}`);
      }

      const reader = response.body.getReader();
      this.reader = reader;

      this.readyState = DesktopEventSource.OPEN;
      const opened = new Event("open");
      this.dispatchEvent(opened);
      this.onopen?.(opened);

      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (this.closed) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // A chunk can end in the middle of a CRLF pair; hold the stray \r.
        const trailingCr = buffer.endsWith("\r");
        const frames = (trailingCr ? buffer.slice(0, -1) : buffer).split(/\r?\n\r?\n/);
        buffer = (frames.pop() ?? "") + (trailingCr ? "\r" : "");
        for (const frame of frames) {
          // A listener that throws is the page's bug, not the stream's: report
          // it the way the platform would and keep reading.
          try {
            this.deliver(frame);
          } catch (error) {
            queueMicrotask(() => { throw error; });
          }
          if (this.closed) return;
        }
      }

      // EOF, reported exactly like any other dropped stream.
      throw new Error("the event stream ended");
    } catch {
      this.failed(false);
    }
  }

  /**
   * Ends one attempt: silent and CLOSED when the server gave a final answer,
   * otherwise one `error` event and a retry. A listener is free to `close()`
   * during that event — this instance then stays down instead of reconnecting.
   */
  private failed(giveUp: boolean): void {
    this.releaseReader();
    if (this.closed) return;

    this.readyState = giveUp ? DesktopEventSource.CLOSED : DesktopEventSource.CONNECTING;
    const failure = new Event("error");
    this.dispatchEvent(failure);
    this.onerror?.(failure);
    if (this.closed || giveUp) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, this.retryMs);
  }

  /** Parses one SSE frame; comment-only frames are heartbeats. */
  private deliver(frame: string): void {
    let name = "message";
    let id: string | undefined;
    const data: string[] = [];

    for (const rawLine of frame.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") name = value;
      else if (field === "data") data.push(value);
      else if (field === "id" && !value.includes("\0")) id = value;
      // Avoid timer overflow turning a long requested retry into a busy loop.
      else if (field === "retry" && /^\d+$/.test(value)) this.retryMs = Math.min(Number(value), 2_147_483_647);
    }

    if (id !== undefined) this.lastEventId = id;
    if (data.length === 0) return;

    const event = new MessageEvent(name === "message" ? "message" : name, {
      data: data.join("\n"),
      lastEventId: this.lastEventId,
      origin: new URL(this.url, window.location.href).origin,
    });
    const handler = name === "message" ? this.onmessage : null;
    if (handler) handler(event);
    this.dispatchEvent(event);
  }
}

declare global {
  interface Window {
    EventSource: typeof EventSource;
  }
}

export function installDesktopEventSource(): void {
  window.EventSource = DesktopEventSource as unknown as typeof EventSource;
}
