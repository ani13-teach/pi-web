/**
 * `next/navigation` replacement.
 *
 * AppShell keeps the selected session in the URL (`?session=…`) and reads it
 * back on load, so the shim has to support history updates plus a subscription
 * that makes `useSearchParams()` re-render. Nothing here talks to a server.
 */
import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

function snapshot(): string {
  return window.location.search;
}

export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, snapshot, snapshot);
  return new URLSearchParams(search);
}

export function usePathname(): string {
  const pathname = useSyncExternalStore(subscribe, () => window.location.pathname, () => "/");
  return pathname;
}

export interface NavigateOptions {
  scroll?: boolean;
}

function navigate(url: string, replace: boolean): void {
  const target = new URL(url, window.location.href);
  const next = `${target.pathname}${target.search}${target.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) {
    notify();
    return;
  }
  if (replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
  notify();
}

export function useRouter() {
  return {
    push: (url: string) => navigate(url, false),
    replace: (url: string, _options?: NavigateOptions) => navigate(url, true),
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    refresh: () => notify(),
    prefetch: () => {},
  };
}

/** Next exports this type from next/navigation; re-exported for the ported code. */
export type ReadonlyURLSearchParams = URLSearchParams;

export function useParams(): Record<string, string> {
  return {};
}

export function useCallbackStable<T extends (...args: never[]) => unknown>(fn: T): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(fn, []);
}
