# MCP implementation provenance

- Source: installed `@earendil-works/pi-coding-agent` **1.1.0**, `dist/extensions/mcp/index.js`.
- License: MIT. `LICENSE` preserves the upstream notice from `earendil-works/pi` tag `v1.1.0` (commit `abe508e1b89912adde45528136c3221eb69acdd7`), root `LICENSE`.
- `vendor.mjs` reproducibly copies this implementation into `core.mjs`. Original helpers are dynamically imported from the installed package inside the asynchronous factory, without top-level await.
- Changes: generic error notices and privacy-preserving diagnostic log metadata (server message bodies are omitted); read-only redacted snapshots; bounded existing-attempt checks; reconnect using the original connection/discovery path; tool-result ownership/time/success observation (no result retention); guarded disposal and cancellation. Normal config loading, discovery, namespace, exposure, commands, tool execution and permissions remain upstream.
- Desktop generation, session retention, settings roots/trust and codemode selection restrictions live in `lib/mcp-runtime.ts`.
- Tests: `lib/mcp-runtime.test.mjs` uses an in-memory transport and log sink; `lib/mcp-desktop-sdk.test.mjs` and `lib/subagent-capabilities.test.mjs` verify real SDK routing and scopes with a local stdio fixture; `tests/mcp-backend-ipc.mjs` verifies the compiled desktop backend. No paid model or personal MCP server is used. These tests do not replace real-window or packaged-application acceptance, or OS-level network isolation.
- Regenerate using `node builtin/mcp/vendor.mjs` against the pinned core version, then run `npm run test:mcp` and `npm run typecheck`. Do not assume an SDK upgrade is compatible without updating this adapter.
