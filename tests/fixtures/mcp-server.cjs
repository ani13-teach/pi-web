// Standalone, local-only MCP acceptance fixture. No files except its optional test ledger.
const readline = require("node:readline");
const fs = require("node:fs");
const ledger = process.argv[2];
readline.createInterface({ input: process.stdin }).on("line", line => {
  let request; try { request = JSON.parse(line); } catch { return; }
  if (ledger) fs.appendFileSync(ledger, request.method + "\n");
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case "initialize": result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "desktop-fixture", version: "1" } }; break;
    case "tools/list": result = { tools: [
      { name: "read_fixture", description: "Returns a fixed fixture value", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
      { name: "write_fixture", description: "Never use in connection checks", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
    ] }; break;
    case "tools/call": result = { content: [{ type: "text", text: "local-fixture-ok" }] }; break;
    default: result = {};
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
