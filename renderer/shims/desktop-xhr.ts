/**
 * Minimal XMLHttpRequest, only for the one upload path in FileExplorer.tsx that
 * needs upload progress. Everything else in pi-web uses fetch.
 */
import { bridgeRequest } from "./desktop-http";

class UploadProgressEvent extends Event {
  readonly lengthComputable: boolean;
  constructor(readonly loaded: number, readonly total: number) {
    super("progress");
    this.lengthComputable = total > 0;
  }
}

class UploadTarget extends EventTarget {
  onprogress: ((event: UploadProgressEvent) => void) | null = null;
  progress(loaded: number, total: number): void {
    const event = new UploadProgressEvent(loaded, total);
    this.onprogress?.(event);
    this.dispatchEvent(event);
  }
}

class DesktopXMLHttpRequest extends EventTarget {
  static readonly UNSENT = 0;
  static readonly OPENED = 1;
  static readonly HEADERS_RECEIVED = 2;
  static readonly LOADING = 3;
  static readonly DONE = 4;

  readonly UNSENT = 0;
  readonly OPENED = 1;
  readonly HEADERS_RECEIVED = 2;
  readonly LOADING = 3;
  readonly DONE = 4;

  readyState = 0;
  status = 0;
  statusText = "";
  responseText = "";
  responseType = "";
  response: unknown = null;

  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onprogress: ((event: ProgressEvent) => void) | null = null;

  readonly upload = new UploadTarget();

  private method = "GET";
  private url = "";
  private abortController = new AbortController();
  private settled = false;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }

  setRequestHeader(): void {
    // Headers are derived from the body by the transport; nothing to store.
  }

  getResponseHeader(): string | null {
    return null;
  }

  abort(): void {
    this.abortRequest();
  }

  abortRequest(): void {
    if (this.settled) return;
    this.settled = true;
    this.abortController.abort();
    this.readyState = 4;
    this.status = 0;
    this.onabort?.();
  }

  async send(body?: Document | XMLHttpRequestBodyInit | null): Promise<void> {
    try {
      let total = 0;
      const response = await bridgeRequest(this.url, {
        method: this.method,
        body: (body ?? null) as BodyInit | null,
        signal: this.abortController.signal,
        onBodyEncoded: (bytes) => {
          total = bytes;
          this.upload.progress(0, total);
        },
      });
      const text = await response.text();
      if (this.settled) return;
      this.settled = true;
      this.readyState = 4;
      this.status = response.status;
      this.statusText = response.statusText;
      this.responseText = text;
      this.response = text;
      // IPC sends one body, so only start/completion are measurable. Do not
      // invent intermediate percentages or use response text as upload bytes.
      if (response.ok && total > 0) this.upload.progress(total, total);
      this.onload?.();
    } catch (error) {
      if (this.abortController.signal.aborted) {
        this.abortRequest();
        return;
      }
      if (this.settled) return;
      this.settled = true;
      this.readyState = 4;
      this.status = 0;
      console.error("upload failed", error);
      this.onerror?.();
    }
  }
}

declare global {
  interface Window {
    XMLHttpRequest: typeof XMLHttpRequest;
  }
}

export function installDesktopXhr(): void {
  window.XMLHttpRequest = DesktopXMLHttpRequest as unknown as typeof XMLHttpRequest;
}
