import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
let entry;
try { entry = createRequire(import.meta.url).resolve('@earendil-works/pi-coding-agent'); }
catch { entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')); }
const dist = dirname(entry);
const version = JSON.parse(readFileSync(join(dirname(dist), 'package.json'), 'utf8')).version;
if (version !== '1.1.0') throw new Error('MCP adapter must be reviewed before vendoring a different core version.');
const original = readFileSync(join(dist, 'extensions/mcp/index.js'), 'utf8');
let body = original;
const imports = [];
body = body.replace(/^import ([\s\S]*?) from "([^"\n]+)";\n/gm, (line, binding, specifier) => {
  if (specifier.startsWith('node:')) return line;
  imports.push(`    const ${binding} = await import(pathToFileURL(resolve(mcpDir, ${JSON.stringify(specifier)})).href);`);
  return '';
});
const nodeImports = body.match(/^import .* from "node:[^"]+";\n/gm).join('');
body = body.replace(/^import .* from "node:[^"]+";\n/gm, '').replace(/^export /gm, '').replace('default createMcpExtension();', '').replace(/^\/\/# sourceMappingURL=.*$/m, '');
function patch(from, to) {
  if (body.split(from).length !== 2) throw new Error('Nonunique vendor patch: ' + from.slice(0,80));
  body = body.replace(from, to);
}
patch('        const emitChange = () => {', `        const lastCalls = new Map();
        let runtimeError;
        const snapshot = () => ({
            started: !session.signal.aborted,
            autoEnableCodemode,
            errors: [...configErrors.map(() => "MCP configuration could not be loaded."), ...(runtimeError ? [runtimeError] : [])],
            servers: servers.map((server) => {
                const { entry, connection } = server;
                return {
                    name: entry.name, source: entry.source, scope: entry.scope ?? "global",
                    enabled: isEnabled(server), exposure: exposureOf(entry),
                    state: !isEnabled(server) ? "disabled" : connection?.state ?? (runtimeError ? "failed" : "starting"),
                    tools: (connection?.tools ?? []).map((tool) => ({ name: tool.name,
                      registeredName: [...toolOwners].find(([, owner]) => owner === \`\${entry.name}\\0\${tool.name}\`)?.[0],
                      exposure: getMcpToolExposure(entry.config, tool.name) })),
                    resourceCount: (connection?.resources.length ?? 0) + (connection?.resourceTemplates.length ?? 0),
                    hasResources: connection?.hasResources ?? false,
                    ...(connection?.error || runtimeError ? { error: "MCP connection failed; see local diagnostics." } : {}),
                    ...(lastCalls.has(entry.name) ? { lastCall: { ...lastCalls.get(entry.name) } } : {}),
                };
            }),
        });
        const emitChange = () => {
            // Observation cannot affect transport, tools, or permission handling.
            try { options.onSnapshot?.(snapshot()); } catch { }`);
patch('            session = new AbortController();', '            session.abort();\n            session = new AbortController();\n            runtimeError = undefined;\n            lastCalls.clear();');
patch('            emitChange();\n            // Codemode or tool_search', `            emitChange();
            const assertCurrent = () => {
                if (signal.aborted || session.signal !== signal) throw new Error("MCP runtime is no longer active.");
            };
            try { options.onController?.({
                dispose: () => { assertCurrent(); return shutdown(); },
                check: async (timeoutMs = 5000) => {
                    assertCurrent();
                    await Promise.resolve();
                    let timer;
                    let onAbort;
                    try {
                        await Promise.race([
                            Promise.all([pending, ...servers.map((server) => server.ready)]),
                            new Promise((resolve) => { timer = setTimeout(resolve, Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 10000)) : 5000); }),
                            new Promise((resolve) => { onAbort = resolve; signal.addEventListener("abort", onAbort, { once: true }); }),
                        ]);
                        assertCurrent();
                        return snapshot();
                    } finally {
                        clearTimeout(timer);
                        if (onAbort) signal.removeEventListener("abort", onAbort);
                    }
                },
                retry: async (name) => {
                    assertCurrent();
                    const server = findServer(name);
                    if (!server || !isEnabled(server) || !server.connection) throw new Error("MCP server is unavailable for retry.");
                    const failure = await track(reconnect(server));
                    assertCurrent();
                    if (failure) throw new Error("MCP reconnect failed; see local diagnostics.");
                    ensureDiscoveryActive(ctx);
                    emitChange();
                    return snapshot();
                },
            }); } catch { }
            // Codemode or tool_search`);
patch('                // The session may have been disposed meanwhile, which makes ctx stale.\n                try {', '                // The session may have been disposed meanwhile, which makes ctx stale.\n                if (signal.aborted) return;\n                runtimeError = "MCP runtime could not be loaded.";\n                emitChange();\n                try {');
patch('        pi.on("session_shutdown", async () => {', `        pi.on("tool_result", (event) => {
            if (session.signal.aborted) return;
            const owner = toolOwners.get(event.toolName)?.split("\\0", 1)[0];
            if (!owner || !findServer(owner)) return;
            lastCalls.set(owner, { at: Date.now(), success: !event.isError });
            emitChange();
        });
        pi.on("session_shutdown", async () => {`);
patch('            const previous = server.ready;\n            const ready = (async () => {\n                await previous;\n                await connection.reconnect();', '            const previous = server.ready;\n            const signal = session.signal;\n            const ready = (async () => {\n                await previous;\n                if (signal.aborted || !servers.includes(server)) return;\n                await connection.reconnect();');
patch('        pi.on("session_shutdown", async () => {\n            session.abort();\n            const closing = connections();\n            servers = [];\n            emitChange();\n            await Promise.all([...backgroundActions, ...closing.map((connection) => connection.close())]);\n        });', `        const shutdown = async () => {
            session.abort();
            const closing = connections();
            const settling = [pending, ...servers.flatMap((server) => [server.ready, server.closing]), ...backgroundActions];
            servers = [];
            emitChange();
            listeners.clear();
            toolOwners.clear();
            tokensAtSignIn.clear();
            lastCalls.clear();
            await Promise.allSettled([...settling, ...closing.map((connection) => connection.close())]);
        };
        pi.on("session_shutdown", shutdown);`);
// Test hosts can supply an in-memory sink; normal sessions retain core's log location.
patch('serverLog ??= new runtime.McpServerLog(', 'serverLog ??= options.log ?? new runtime.McpServerLog(');
// Desktop notices and server-generated diagnostic log bodies must not expose credentials.
patch('return error instanceof Error ? error.message : String(error);', 'return "MCP operation failed; check configuration, program and authentication.";');
patch('return withError ? `failed: ${firstLine(connection.error ?? "unknown error")}` : "failed";', 'return withError ? "failed: check configuration, program and authentication" : "failed";');
body = body.replaceAll('configErrors.map((error) => `config: ${error}`)', 'configErrors.map(() => "config: MCP configuration could not be loaded.")');
patch('lines.push(`config error: ${error}`);', 'lines.push("config error: MCP configuration could not be loaded.");');
patch('connection.error.split("\\n").join("\\n    ")', '"MCP connection failed; check configuration, program and authentication."');
patch('            return serverLog;', `            return { write(name, message) {
                const levels = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];
                // Keep diagnostic event metadata, never server-provided payloads or logger strings.
                serverLog.write?.(name, { level: levels.includes(message?.level) ? message.level : "info", data: "MCP diagnostic body omitted for privacy." });
            } };`);
const header = `${nodeImports}import { createRequire as createObservedMcpRequire } from "node:module";\nimport { dirname } from "node:path";\nimport { pathToFileURL, fileURLToPath } from "node:url";\n\n// Vendored MIT implementation, pi-coding-agent 1.1.0. See SOURCE.md.\nexport function createObservedMcpExtension(options = {}) {\n    return async (pi) => {\n        let entry;\n        try { entry = createObservedMcpRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent"); }\n        catch { entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")); }\n        const dist = dirname(entry);\n        const version = createObservedMcpRequire(import.meta.url)(join(dist, "..", "package.json")).version;\n        if (version !== "1.1.0") throw new Error("MCP adapter is incompatible with this core version; update the adapter first.");\n        const mcpDir = join(dist, "extensions", "mcp");\n${imports.join('\n')}\n`;
writeFileSync(new URL('./core.mjs', import.meta.url), header + body + '\n        await createMcpExtension(options)(pi);\n    };\n}\n');
