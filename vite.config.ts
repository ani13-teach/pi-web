import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

function readVersion(pkgPath: string): string {
  const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  if (!parsed.version) throw new Error(`No version field in ${pkgPath}`);
  return parsed.version;
}

// Both versions are read from the installed packages so they cannot drift from
// what actually ships. The desktop suffix keeps the host out of the web
// app-update check, which only understands plain "x.y.z" versions.
const appVersion = `${readVersion(join(root, "package.json"))}-desktop`;
const piVersion = readVersion(
  join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
);

export default defineConfig({
  root: fileURLToPath(new URL("./renderer", import.meta.url)),
  // Relative asset paths: the renderer is served from pi-app://app/, and a
  // leading slash would resolve against the scheme root instead.
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      // Next.js APIs the ported pi-web UI expects, mapped onto the desktop.
      { find: /^next\/navigation$/, replacement: `${root}renderer/shims/next-navigation.ts` },
      { find: /^next\/image$/, replacement: `${root}renderer/shims/next-image.tsx` },
      { find: /^next\/font\/google$/, replacement: `${root}renderer/shims/next-font.ts` },
      // The app source keeps its original "@/…" import style.
      { find: /^@\//, replacement: root },
    ],
  },
  define: {
    // Read by the "about" footer in ChatWindow.
    "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify(appVersion),
    "process.env.NEXT_PUBLIC_PI_VERSION": JSON.stringify(piVersion),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/renderer", import.meta.url)),
    emptyOutDir: true,
    // The window is a known Chromium, so nothing needs down-levelling.
    target: "chrome152",
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
});
