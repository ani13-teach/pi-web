# Vendored pi-automode

This directory is a copy of the local `pi-automode` plugin, compiled into the
desktop backend by `scripts/build-desktop.mjs`. It is loaded as an inline
extension from `lib/automode-builtin.ts`, not discovered from disk.

Upstream: https://github.com/czottmann/pi-automode (MIT).

## What was copied

| Copied | Not copied |
|---|---|
| `extensions/index.ts` (was `extensions/auto-mode.ts`, the plugin entry) | `docs/`, `tests/`, `skills/`, `examples/` |
| `extensions/auto-mode/*.ts` (15 modules) | `config.json` (user configuration, not source) |
| `LICENSE.md` | `.github/`, `node_modules/` |

## Provenance

- Base commit: `011bd1f1fe9289c616233e19f1d2b2fe81d174ab` ("chore(release): 1.14.0")
- Local working-tree changes on top: 883-line diff against that commit
  (classifier, config, extension, log, state, types plus docs and tests)
- The plugin entry was renamed from `auto-mode.ts` to `index.ts`: a vendored
  module entry read from this repository must not collide with auto mode's own
  file-name protection, which treats any in-tree `*auto-mode*` file as a
  safety control and refuses agent writes to it.

## Re-vendoring

From a checkout of the plugin (the local install is itself a git clone):

```bash
git -C <plugin-checkout> rev-parse HEAD
git -C <plugin-checkout> diff > /tmp/automode-local.patch
git -c core.autocrlf=false clone <plugin-checkout> /tmp/amsrc
git -C /tmp/amsrc apply /tmp/automode-local.patch
rm -rf builtin/automode/extensions && cp -r /tmp/amsrc/extensions builtin/automode/
mv builtin/automode/extensions/auto-mode.ts builtin/automode/extensions/index.ts
cp /tmp/amsrc/LICENSE.md builtin/automode/LICENSE.md
```

Then update the version in `lib/automode-builtin.ts` and the commit above.

`unbash` (the plugin's only runtime dependency) is a normal dependency in
`package.json`; `typebox` resolves to the copy the pi packages already pin.
