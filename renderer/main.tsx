/**
 * Desktop renderer entry.
 *
 * The UI itself is pi-web's, unmodified: the shims below only replace the
 * browser↔server plumbing (fetch, EventSource, XMLHttpRequest, next/navigation)
 * with the Electron IPC bridge.
 */
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { AppShell } from "../components/AppShell";
import { I18nProvider } from "../hooks/useI18n";
import { isDarkTheme, isThemePreference } from "../lib/theme";

import { BackendRecoveryBar } from "./backend-recovery";
import { installDesktopEventSource } from "./shims/desktop-eventsource";
import { installDesktopFetch } from "./shims/desktop-fetch";
import { installDesktopXhr } from "./shims/desktop-xhr";

import "./desktop.css";

/**
 * The same work lib/theme's THEME_INIT_SCRIPT does in the web build, without an
 * inline script: in a desktop window there is no server round trip to hide, and
 * running it before the first render is enough to avoid a flash.
 */
function applyInitialTheme(): void {
  let preference = "auto";
  try {
    const saved = localStorage.getItem("pi-theme");
    if (isThemePreference(saved)) preference = saved;
  } catch {
    // storage blocked: fall through to the system preference
  }
  const resolved = preference === "auto"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : preference;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.classList.toggle("dark", resolved === "dark" || resolved === "pine");
}

function installShims(): void {
  installDesktopFetch();
  installDesktopEventSource();
  installDesktopXhr();
}

function reportFatal(error: unknown): void {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ""}` : String(error);
  console.error("[pi-desktop] renderer failed to start:", message);
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = "";
  const box = document.createElement("pre");
  box.style.cssText = "padding:16px;font:12px/1.5 ui-monospace,Consolas,monospace;color:#e88;white-space:pre-wrap";
  box.textContent = `The interface failed to start:\n\n${message}`;
  root.appendChild(box);
}

try {
  installShims();
  applyInitialTheme();
  const container = document.getElementById("root");
  if (!container) throw new Error("missing #root element");
  createRoot(container).render(
    <StrictMode>
      <Suspense fallback={null}>
        {/*
          The bar sits above the ported UI, which itself is untouched. #root is
          full height, so the column has to hand it the rest of the space.
        */}
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <BackendRecoveryBar />
          <div style={{ flex: "1 1 auto", minHeight: 0 }}>
            <I18nProvider>
              <AppShell />
            </I18nProvider>
          </div>
        </div>
      </Suspense>
    </StrictMode>,
  );
} catch (error) {
  reportFatal(error);
}
