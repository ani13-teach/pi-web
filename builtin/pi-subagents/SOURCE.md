# pi-subagents source

- Package: `@tintinweb/pi-subagents@0.19.0` (MIT).
- Original project: https://github.com/tintinweb/pi-subagents
- Imported from: `C:/Users/jch/.pi/agent/local/pi-subagents`.
- The entire source `src/` tree was copied, including the local per-agent fallback-model implementation. No `node_modules/`, `dist/`, or files outside the selected source tree and provenance files were copied.
- `LICENSE`, `LOCAL-CHANGES.md`, and `package.json` are byte-for-byte copies of the source files. The manifest/package here is provenance, not a separate dependency-install target; Desktop's root package owns build dependencies.
- The external source directory is unchanged. Desktop-specific edits are listed in `DESKTOP-PATCHES.md` and hashed in `SOURCE-MANIFEST.json`.

## Verify

From the Desktop repository:

```bash
node builtin/pi-subagents/scripts/source-manifest.mjs
node builtin/pi-subagents/scripts/source-manifest.mjs --source C:/Users/jch/.pi/agent/local/pi-subagents
```

The first checks the complete vendored `src/` inventory and its byte hashes. The second also checks the original source inventory and hashes. A changed file is expected only if its recorded `sourceSha256` differs from `desktopSha256`; a Desktop-added file has `sourceSha256: null`.

To deliberately update the recorded hashes after reviewing a Desktop patch:

```bash
node builtin/pi-subagents/scripts/source-manifest.mjs --refresh --source C:/Users/jch/.pi/agent/local/pi-subagents
```
