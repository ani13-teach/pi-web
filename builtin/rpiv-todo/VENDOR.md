# Vendored rpiv-todo

Source: installed `@juicesharp/rpiv-todo@2.9.0` (MIT), from
`~/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo/`; upstream:
https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo.
`LICENSE` is included. This directory contains the package's runtime `.ts`
files and `locales/*.json`; README/docs/package metadata are not needed at runtime.

Pi Desktop-only changes:
- `index.ts`, `todo.ts`, `todo-overlay.ts`, `state/store.ts`: each inline extension
  factory binds its own session id, UI context and overlay; overlay and tool
  render hooks read that session's state rather than a module-global foreground
  pointer. Mutations still use the calling context's `sid(ctx)`.
- `config.ts`, new `config-support.ts`: inline only the rpiv-config config reader
  and guidance validation used here, retaining the XDG and legacy path behavior
  so the bundle does not depend on the global rpiv-config install.
- `state/i18n-bridge.ts`: read rpiv-i18n's process-wide locale snapshot. Pi
  loads the installed extension before filtering its duplicate, so it registers
  strings in the same snapshot; `/languages` updates remain live. Without the
  optional i18n plugin the original English fallbacks apply. The desktop build
  embeds the MIT LICENSE; source locale files remain here for upstream parity.
- `lib/rpiv-todo-builtin.ts` and `lib/rpc-manager.ts`: choose this copy only when
  an external rpiv-todo was configured/loaded by Pi, filtering the duplicate
  after resource loading. This does not alter the CLI/global package.
