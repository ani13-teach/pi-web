import { watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";

// Poll the files themselves: editors commonly replace them via rename. Shared,
// unref'ed watchers also work for absent files without keeping the backend alive.
type WatchEntry = { listeners: Set<() => void>; changed: () => void; timer?: ReturnType<typeof setTimeout> };
const watchers = new Map<string, WatchEntry>();
export function watchMcpConfigFiles(agentDir: string, cwd: string, onChange: () => void): () => void {
  const files = [join(agentDir, "mcp.json"), join(cwd, ".pi", "mcp.json"), join(agentDir, "trust.json")];
  for (const file of files) {
    let entry = watchers.get(file);
    if (!entry) {
      const listeners = new Set<() => void>();
      const created: WatchEntry = { listeners, changed: () => {
        if (created.timer) clearTimeout(created.timer);
        created.timer = setTimeout(() => { created.timer = undefined; for (const listener of [...listeners]) { try { listener(); } catch { /* observer only */ } } }, 150);
        created.timer.unref?.();
      } };
      entry = created; watchers.set(file, entry);
      watchFile(file, { persistent: false, interval: 1000 }, entry.changed);
    }
    entry.listeners.add(onChange);
  }
  let disposed = false;
  return () => {
    if (disposed) return; disposed = true;
    for (const file of files) {
      const entry = watchers.get(file);
      if (!entry) continue;
      entry.listeners.delete(onChange);
      if (!entry.listeners.size) { unwatchFile(file, entry.changed); if (entry.timer) clearTimeout(entry.timer); watchers.delete(file); }
    }
  };
}
