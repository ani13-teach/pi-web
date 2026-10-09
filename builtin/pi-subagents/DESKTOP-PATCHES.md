# Desktop patches

The base is the complete local `pi-subagents` 0.19.0 source, not a replacement execution engine. Workflows, schedules, structured output, nested delegation, worktrees, and per-agent fallback models remain present.

## Module isolation and build

`scripts/build-desktop.mjs` bundles `src/index.ts` and all its relative/dynamic imports into one `dist/main/pi-subagents.mjs` ESM file (`splitting: false`). Only `@earendil-works/*` packages remain external (Node builtins are inherently external); third-party dependencies are bundled. The `createRequire` banner matches the backend banner. License and provenance documents are copied to `dist/main/pi-subagents/`.

Desktop must dynamically import that bundle with a unique query for each root session, call `configureDesktopHost()` before activating its default factory, and not cache/reuse one configured module across roots. The complete relative module graph, including upstream module-level settings, then belongs to that root. The existing child-loading ALS guard is retained without redesign.

## Source changes

- `src/desktop-host.ts` (new): optional module-local host, `configureDesktopHost()`, `desktopCwd()`, and typed manager/child/loader bridges. Loader option types are derived from SDK 0.85.1's public constructor/reload signatures because the SDK does not re-export their named interfaces. `maxConcurrent` accepts a live host getter.
- `src/index.ts`: re-exports the host configuration/types; reports the newly constructed manager; applies the host concurrency override in `session_start`, after the upstream factory has applied persisted settings and before any scheduler/workflow can spawn. Desktop activations do not claim the process-global first-root Symbol registry; CLI behavior is retained.
- `src/agent-runner.ts`: optional host strategy for loader construction and trust-aware reload; host child binding at the original bind position; retains extension tool-scope installation and `onSessionCreated`. Passes parent context, id, profile, description, task, config cwd, requested tools, extension/skill flags, and system prompt to the host. Setup failure after session creation tears the child down before rethrowing. Captures the owning host before any await so creation finishing after root shutdown cannot fall back to CLI binding. Shares SettingsManager with the loader and allows an asynchronous pre-import filtering strategy. Execution, usage, resume, and model-fallback paths are unchanged.
- `src/agent-manager.ts`: forwards the description to the runner; centralized child shutdown delegates to the host without a second SDK shutdown emit/dispose. Desktop disposal disconnects completion callbacks before a cancelled provider can settle into a stale root API, and skips detached git pruning for roots that never created a worktree. Without a host, upstream bounded teardown remains in place.
- `src/custom-agents.ts`: exports `readAgentConfigFile()` by extracting the original single-file conversion; both the native loader and Desktop profile editor use it. There is no second frontmatter parser or default-profile prompt set.
- `src/agent-file-toggle.ts`, `src/agent-manager.ts`, `src/cross-extension-rpc.ts`, `src/enabled-models.ts`, `src/index.ts`, `src/settings.ts`: all original `process.cwd()` calls now use `desktopCwd()`; only its fallback calls `process.cwd()`.

## Pi 1.1.0 mention clones

`src/mention-clone.ts` seeds an in-memory `SessionManager` before constructing the clone. It uses `buildSessionContext()` to resolve the active parent branch, compaction and context edits, deep-copies the projected messages, and restores compaction/branch summaries through the manager's native append APIs. Parent system messages are excluded from this history so their old tool declarations cannot replace the clone's single `Agent` tool. No parent history object or persisted session file is modified.

The parent's current `ctx.getSystemPrompt()` is supplied through `DefaultResourceLoader.systemPromptOverride` and the native `before_agent_start` hook. The hook forces the exact effective text, avoiding duplicate prompt appendices or structured cwd sections. The default resource discovery and extension permission handlers remain in place. The clone no longer assigns the read-only `agent.state.systemPrompt` or pushes messages into the non-canonical agent state.

The forwarded `Agent` execution retains the parent's `ExtensionContext` fields and session ownership, while taking `tools` and `executeTool` from the clone's real `ExtensionToolContext`. It still forces background execution, omits the clone-only tool-call id, and permits only one spawn per mention.

`lib/mention-clone.test.mjs` bundles this source directly and exercises SDK 1.1.0 with an in-memory credential store, temporary resource directory and local mock provider. Regression coverage verifies the first request's projected history and exact live prompt, the single-tool loadout, parent history/leaf preservation, parent attribution and nested tool capabilities, duplicate-call suppression, and empty-history/no-spawn fallback. `lib/subagent-extension.test.mjs` reads mock provider system text via `pi-ai.getCurrentSystemPrompt(context.messages)` for the new transcript contract. Its integration tests still require the separately rebuilt Desktop bundle; the mention regression does not.

## Desktop agent presets

`src/desktop-agent-presets.ts` snapshots the user's existing global `agents/planner.md`, `reviewer.md`, `scout.md`, `tester.md`, and `worker.md` as native `AgentConfig` values, now named `plan`, `review`, `scout`, `test`, and `work`. These are the only five embedded defaults; the original Agent/Explore/Plan definitions and duplicate long names are removed. The original files remain read-only provenance, not dependencies, and are neither removed nor rewritten.

`src/builtin-agents.ts` loads editable/new built-ins from `$PI_CODING_AGENT_DIR/desktop-agents/*.md` over the embedded presets. Deletion markers under `.deleted/` persist deletion or renaming without resurrecting presets; exact IDs are UTF-8 hex-encoded so Windows can distinguish `work` and `Work`. `src/agent-types.ts` merges these built-ins last, above project/workspace/global user profiles. Native disable-defaults suppresses only factory presets, not explicitly saved Desktop profiles. The Desktop UI marks the exact runtime winner using the native registry and merged settings. Unknown-type fallback uses enabled `work` only; missing/disabled work fails closed, never reviving an embedded or hidden general-purpose config. Internal wizard/workflow defaults and the tool guidance use the new IDs.

The Desktop profiles API accepts `builtin` scope and optional `originalName`/`createOnly`; renaming preserves unknown frontmatter, checks collisions before writing, moves to the new filename and removes the old source. Preset renames mark the old identity deleted. DELETE accepts an exact source path. UI edits remain bound to the selected source, allow ID input and preset deletion, and default creation to builtin; lower sources remain independently selectable.

All five retain their original prompts, descriptions, tools, model `哈尔/gpt-6.1-sol`, fallback `openai-codex/gpt-6.1-sol`, thinking level, max turns, append prompt mode, enabled state, disabled skills/extensions, and non-inherited execution defaults. Desktop presets inherit caller defaults (top-level background, nested foreground) rather than hard-coding a mode; an explicit invocation mode overrides the profile mode. File provenance changes to `source: default`, `isDefault: true`, with no `sourcePath`. Channels/credentials are not copied; unavailable model choices can be changed in the existing UI.

Original file SHA-256 at snapshot time (not re-read on app startup):

| Definition | SHA-256 |
|---|---|
| planner.md | `7793ca2dd3fd3dce9d9dc959e628845f0edfa494bba7702a15f90b7f7b0e7abb` |
| reviewer.md | `5ce657a7c53d556bf277b8a38516042714e185f35960f4dafd74cfc413adb9eb` |
| scout.md | `73e8d33a8d262e87d61aca880d969187b31acac26bc9b504e6ba5d00ce2844e2` |
| tester.md | `ac66745cc439d834f09c18d17d1a5767ed7cb0e19f6485f2546e479ce91563e7` |
| worker.md | `6bcf12bff0369aed8b9bd224431aa910e7615a0240121214950daa4b0963c658` |

## Background execution and quiet display

`src/invocation-config.ts` resolves only execution mode as explicit invocation > effective profile > caller default. Tool/model/isolation restrictions remain unchanged, and nested caller defaults remain foreground. `loadBuiltinAgents(strict, includePresets)` can suppress embedded presets while retaining user-saved Desktop profiles and deletion markers. The UI uses `buildAgentRegistry` and merged settings to report the real winner and default mode.

The host adds a result-origin marker for the SDK-proven native control tools, including results without a child-session link. Live wire projections carry UI-only origin metadata derived from the SDK `<inline:pi-subagents>` tool source; they do not mutate the SDK message or model context. Main chat hides those blocks and source-tagged `subagent-notification` records before process grouping/counting. Before SDK validation/permission checks, the host persists exact assistant-entry/call IDs as separate `pi-web:subagent-display` metadata so invalid/denied calls restore quietly across history pagination without contaminating model context. Old notifications are recognized by their known structured payload, not their custom type alone. Direct subagent-session views retain their full content. Sidebar/search visibility uses the persisted subagent relation; the complete catalog and existing `Agents` navigation remain intact. Notification follow-up delivery, errors, ownership and shutdown semantics are unchanged.

See `docs/subagent-background-silence.md` for behavior, validation and bounded rollback.

## Host ownership and limits

`lib/subagent-extension.ts` supplies the Desktop adapter: pre-import source discovery filters duplicate pi-subagents installations and untrusted project paths; a root-specific manager bridges result/control and persisted resource snapshots. It owns pending children before their first binding completes, persists aborted state before native shutdown clears records, and makes disposal idempotent. `lib/rpc-manager.ts` registers their IPC wrappers, performs their only bind, disables independent idle eviction, and bounds child shutdown waits.

The host owns child bindings, UI/error routing, resource/trust policy, and child disposal. It must make `shutdownChild()` idempotent (a setup callback can fail after having exposed the session). The extension's optional bridge does not itself implement Desktop events, root dynamic import, root lifecycle, settings UI, or installation of dependencies; those belong to the Desktop adapter/root package.

`SOURCE-MANIFEST.json` records source and Desktop SHA-256 hashes for every imported source/provenance file and any new `src/` file. `scripts/source-manifest.mjs` verifies inventory and bytes without touching the external source, or explicitly refreshes this local manifest.
